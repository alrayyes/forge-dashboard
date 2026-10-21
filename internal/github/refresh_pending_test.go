package github_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func pendingRefs(n int) []dashboard.PullRequestRef {
	refs := make([]dashboard.PullRequestRef, n)
	for i := range refs {
		name := fmt.Sprintf("repo%d", i)
		refs[i] = dashboard.PullRequestRef{
			Forge: dashboard.ForgeGitHub, Owner: "alrayyes", Name: name,
			FullName: "alrayyes/" + name, Number: i + 1,
		}
	}

	return refs
}

// pendingServer answers each aliased pullRequest lookup with an open pull
// request, except the aliases closedAt and brokenAt name. It counts requests.
func pendingServer(t *testing.T, closedAt, brokenAt map[string]bool) (*httptest.Server, *atomic.Int32) {
	t.Helper()

	// BEHIND needs no compare lookup, so the request count is the batch's own.
	return pendingServerWithState(t, "BEHIND", closedAt, brokenAt)
}

func pendingServerWithState(t *testing.T, mergeState string, closedAt, brokenAt map[string]bool) (*httptest.Server, *atomic.Int32) {
	t.Helper()

	var requests atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		body := readGraphQLRequest(t, r)
		data := map[string]any{}
		var errs []map[string]any
		for key, name := range body.Variables {
			index, ok := strings.CutPrefix(key, "name")
			if !ok {
				continue
			}
			alias := "pr" + index
			switch {
			case brokenAt[name.(string)]:
				data[alias] = nil
				errs = append(errs, map[string]any{
					"type": "NOT_FOUND", "path": []string{alias},
					"message": "Could not resolve to a Repository with the name '" + name.(string) + "'.",
				})
			default:
				state := "OPEN"
				if closedAt[name.(string)] {
					state = "MERGED"
				}
				number := body.Variables["number"+index]
				data[alias] = map[string]any{"pullRequest": map[string]any{
					"state": state, "number": number, "title": "t", "url": "u",
					"mergeStateStatus": mergeState, "headRefOid": "deadbeef",
					"autoMergeRequest": nil,
					"labels":           map[string]any{"nodes": []map[string]any{}},
					"createdAt":        "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
					"commits": map[string]any{"nodes": []map[string]any{}},
				}}
			}
		}
		resp := map[string]any{"data": data}
		if len(errs) > 0 {
			resp["errors"] = errs
		}
		writeJSON(t, w, resp)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv, &requests
}

func TestRefreshPending_AnswersEveryRefInTheNumberOfRequestsItsSizeNeeds(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		prs, requests int
	}{{1, 1}, {12, 1}, {25, 1}, {26, 2}, {60, 3}} {
		t.Run(fmt.Sprintf("%d pull requests", tc.prs), func(t *testing.T) {
			t.Parallel()

			srv, requests := pendingServer(t, nil, nil)
			c := github.NewClient("test-token", "", srv.URL)

			res, err := c.RefreshPending(t.Context(), pendingRefs(tc.prs))

			require.NoError(t, err)
			assert.Len(t, res.Pulls, tc.prs)
			assert.EqualValues(t, tc.requests, requests.Load())
		})
	}
}

func TestRefreshPending_AMergedPullRequestIsClosedNotOpen(t *testing.T) {
	t.Parallel()

	srv, _ := pendingServer(t, map[string]bool{"repo1": true}, nil)
	c := github.NewClient("test-token", "", srv.URL)

	res, err := c.RefreshPending(t.Context(), pendingRefs(3))

	require.NoError(t, err)
	require.Len(t, res.Closed, 1)
	assert.Equal(t, "alrayyes/repo1", res.Closed[0].FullName)
	assert.Len(t, res.Pulls, 2)
}

func TestRefreshPending_OneFailingAliasDoesNotFailTheCall(t *testing.T) {
	t.Parallel()

	srv, _ := pendingServer(t, nil, map[string]bool{"repo1": true})
	c := github.NewClient("test-token", "", srv.URL)

	res, err := c.RefreshPending(t.Context(), pendingRefs(3))

	require.NoError(t, err)
	require.Len(t, res.Failed, 1)
	assert.Equal(t, "alrayyes/repo1", res.Failed[0].FullName)
	assert.Len(t, res.Pulls, 2)
}

func TestRefreshPending_ARequestRejectedWholesaleIsAnError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(srv.Close)
	c := github.NewClient("test-token", "", srv.URL)

	_, err := c.RefreshPending(t.Context(), pendingRefs(2))

	require.Error(t, err)
}

// errorServer answers every request with 200 and the one query error given.
func errorServer(t *testing.T, entry map[string]any) *httptest.Server {
	t.Helper()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{}, "errors": []map[string]any{entry}})
	}))
	t.Cleanup(srv.Close)

	return srv
}

func TestRefreshPending_AnErrorOnANonPullRequestAliasFailsTheCall(t *testing.T) {
	t.Parallel()

	srv := errorServer(t, map[string]any{"message": "boom", "path": []string{"rateLimit"}})
	c := github.NewClient("test-token", "", srv.URL)

	_, err := c.RefreshPending(t.Context(), pendingRefs(2))

	require.Error(t, err)
}

func TestRefreshPending_ARateLimitErrorOnAPullRequestAliasFailsTheCall(t *testing.T) {
	t.Parallel()

	srv := errorServer(t, map[string]any{"message": "slow down", "type": "RATE_LIMITED", "path": []string{"pr0"}})
	c := github.NewClient("test-token", "", srv.URL)

	_, err := c.RefreshPending(t.Context(), pendingRefs(2))

	require.Error(t, err, "a throttle is the whole request failing, not one pull request")
}

// failingSecondRequest forwards to inner but answers the second request it sees
// with a 502, as a flaky edge would.
func failingSecondRequest(t *testing.T, inner *httptest.Server) *httptest.Server {
	t.Helper()

	target, err := url.Parse(inner.URL)
	require.NoError(t, err)
	proxy := httputil.NewSingleHostReverseProxy(target)
	var seen atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if seen.Add(1) == 2 {
			w.WriteHeader(http.StatusBadGateway)

			return
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)

	return srv
}

func TestRefreshPending_ALaterChunkFailingKeepsTheEarlierChunksAnswers(t *testing.T) {
	t.Parallel()

	inner, _ := pendingServer(t, nil, nil)
	c := github.NewClient("test-token", "", failingSecondRequest(t, inner).URL)

	res, err := c.RefreshPending(t.Context(), pendingRefs(60))

	require.Error(t, err)
	assert.Len(t, res.Pulls, 25, "the first chunk was paid for, so its answers come back with the error")
}

func TestRefreshPending_NoRefsSendsNothing(t *testing.T) {
	t.Parallel()

	srv, requests := pendingServer(t, nil, nil)
	c := github.NewClient("test-token", "", srv.URL)

	_, err := c.RefreshPending(t.Context(), nil)

	require.NoError(t, err)
	assert.Zero(t, requests.Load())
}
