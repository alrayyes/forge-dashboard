package github_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// upToDateServer serves one open pull request in the given merge state and
// answers the base branch's required-status-checks read with protection, or
// refuses it when protection is nil (a token without admin on the repo). It
// counts those reads so a test can assert on caching.
func upToDateServer(t *testing.T, mergeState string, protection map[string]any, reads *atomic.Int32) *httptest.Server {
	t.Helper()

	return upToDateServerWith(t, mergeState, protection, reads, nil)
}

func upToDateServerWith(t *testing.T, mergeState string, protection map[string]any, reads *atomic.Int32, onProtection func(*http.Request)) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes": []map[string]any{{
							"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
							"owner": map[string]any{"login": "alrayyes"},
							"pullRequests": map[string]any{"nodes": []map[string]any{{
								"number": 7, "title": "feature", "url": "https://github.com/alrayyes/a/pull/7",
								"isDraft": false, "author": map[string]any{"login": "alrayyes"},
								"labels":    map[string]any{"nodes": []map[string]any{}},
								"createdAt": "2026-10-12T12:27:00Z", "updatedAt": "2026-10-12T12:28:00Z",
								"mergeStateStatus": mergeState, "headRefOid": "cafef00d", "baseRefName": "main",
								"autoMergeRequest": map[string]any{"enabledAt": "2026-10-12T12:29:00Z"},
								"commits": map[string]any{"nodes": []map[string]any{
									{"commit": map[string]any{"statusCheckRollup": rollupFixture("SUCCESS", map[string]int{"SUCCESS": 1}, nil)}},
								}},
							}}},
							"issues": map[string]any{"nodes": []map[string]any{}},
						}},
					},
				},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/branches/main/protection/required_status_checks", func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		if onProtection != nil {
			onProtection(r)
		}
		if protection == nil {
			http.Error(w, `{"message":"Resource not accessible by personal access token"}`, http.StatusForbidden)

			return
		}
		writeJSON(t, w, protection)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func TestFetch_BehindPullRequestInAStrictRepo_SaysTheBranchMustBeUpToDate(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32
	srv := upToDateServer(t, "BEHIND", map[string]any{"strict": true, "contexts": []string{"ci"}}, &reads)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	require.NotNil(t, result.PullRequests[0].BaseRequiresUpToDate)
	assert.True(t, *result.PullRequests[0].BaseRequiresUpToDate)
}

func TestFetch_BehindPullRequestInANonStrictRepo_SaysItDoesNot(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32
	srv := upToDateServer(t, "BEHIND", map[string]any{"strict": false, "contexts": []string{"ci"}}, &reads)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	require.NotNil(t, result.PullRequests[0].BaseRequiresUpToDate)
	assert.False(t, *result.PullRequests[0].BaseRequiresUpToDate)
}

func TestFetch_BehindPullRequestWhenProtectionIsUnreadable_LeavesTheRuleUnknown(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32
	srv := upToDateServer(t, "BEHIND", nil, &reads)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Nil(t, result.PullRequests[0].BaseRequiresUpToDate, "nothing is guessed")
}

func TestFetch_UpToDateRule_IsReadOncePerBranchAcrossRefreshes(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32
	srv := upToDateServer(t, "BEHIND", map[string]any{"strict": true}, &reads)
	client := github.NewClient("test-token", "", srv.URL)

	client.Fetch(t.Context())
	client.Fetch(t.Context())

	assert.Equal(t, int32(1), reads.Load())
}

func TestFetch_PullRequestThatIsNotBehind_DoesNotReadTheRule(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32
	srv := upToDateServer(t, "CLEAN", map[string]any{"strict": true}, &reads)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Nil(t, result.PullRequests[0].BaseRequiresUpToDate)
	assert.Zero(t, reads.Load())
}

func TestFetch_UpToDateRule_ACancelledReadIsNotCachedAsUnknown(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	srv := upToDateServerWith(t, "BEHIND", map[string]any{"strict": true}, &reads, func(r *http.Request) {
		if reads.Load() == 1 {
			cancel()
			<-r.Context().Done()
		}
	})
	client := github.NewClient("test-token", "", srv.URL)

	client.Fetch(ctx)
	result := client.Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	require.NotNil(t, result.PullRequests[0].BaseRequiresUpToDate)
	assert.True(t, *result.PullRequests[0].BaseRequiresUpToDate)
	assert.Equal(t, int32(2), reads.Load())
}
