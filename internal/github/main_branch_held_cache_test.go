package github_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// heldBranchServer serves one repo whose newest default-branch commit has no
// check run, and counts the requests made to list its workflow runs. runs
// answers that endpoint.
func heldBranchServer(t *testing.T, requests *atomic.Int32, runs http.HandlerFunc) *httptest.Server {
	t.Helper()

	newest := map[string]any{
		"oid": "d77a71648ce53adf4e77dc02ce7c434f55538953", "abbreviatedOid": "d77a716",
		"messageHeadline": "feat: from a first-time contributor",
		"url":             "https://github.com/alrayyes/a/commit/d77a716",
		"committedDate":   "2026-10-20T09:10:00Z", "statusCheckRollup": nil,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		runs(w, r)
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		rate := map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"}
		if strings.Contains(readGraphQLRequest(t, r).Query, "history(") {
			writeJSON(t, w, map[string]any{"data": map[string]any{"rateLimit": rate, "m0": map[string]any{
				"defaultBranchRef": map[string]any{"target": map[string]any{
					"history": map[string]any{"nodes": []map[string]any{newest}},
				}},
			}}})

			return
		}
		head := branchRef(nil)
		head["target"] = newest
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": rate,
			"viewer": map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false},
				"nodes": []map[string]any{{
					"name": "a", "url": "https://github.com/alrayyes/a", "viewerPermission": "WRITE",
					"owner":            map[string]any{"login": "alrayyes"},
					"pullRequests":     map[string]any{"nodes": []map[string]any{}},
					"issues":           map[string]any{"nodes": []map[string]any{}},
					"defaultBranchRef": head,
				}},
			}},
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

// #2024: the poll asks GitHub whether the newest commit's runs are held, and
// remembers the answer per commit, so a poll every few seconds costs one request
// a minute, not one a poll. A held branch is the case that used to ask again.
func TestFetch_MainBranch_AHeldAnswerIsRememberedBetweenPolls(t *testing.T) {
	t.Parallel()

	var requests atomic.Int32
	srv := heldBranchServer(t, &requests, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{
			"id": 1, "name": "ci", "workflow_id": 7, "html_url": "https://github.com/alrayyes/a/actions/runs/1",
		}}})
	})
	client := github.NewClient("test-token", "", srv.URL)

	first := client.Fetch(t.Context())
	second := client.Fetch(t.Context())

	require.Len(t, first.MainBranches, 1)
	require.Len(t, second.MainBranches, 1)
	assert.Equal(t, dashboard.MainBranchAwaitingApproval, second.MainBranches[0].Status)
	assert.Equal(t, "https://github.com/alrayyes/a/actions/runs/1", second.MainBranches[0].RunURL, "the cached answer keeps the held run's page")
	assert.Equal(t, int32(1), requests.Load(), "the second poll asks nothing")
}

// A token that can't read Actions answers 403 every time. That answer is
// remembered too, so the failing request is not repeated on every poll.
func TestFetch_MainBranch_ACantReadActionsAnswerIsRememberedBetweenPolls(t *testing.T) {
	t.Parallel()

	var requests atomic.Int32
	srv := heldBranchServer(t, &requests, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]any{"message": "Resource not accessible by personal access token"})
	})
	client := github.NewClient("test-token", "", srv.URL)

	client.Fetch(t.Context())
	second := client.Fetch(t.Context())

	require.Len(t, second.MainBranches, 1)
	assert.Equal(t, dashboard.MainBranchNone, second.MainBranches[0].Status, "unreadable reads as not held")
	assert.Equal(t, int32(1), requests.Load(), "the second poll does not ask again")
}
