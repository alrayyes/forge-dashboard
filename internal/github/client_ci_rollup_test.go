package github_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stateCounts builds the rollup's checkRunCountsByState /
// statusContextCountsByState shape: GitHub lists every enum value, zeros
// included, as {state, count} pairs.
func stateCounts(counts map[string]int) []map[string]any {
	out := make([]map[string]any, 0, len(counts))
	for state, n := range counts {
		out = append(out, map[string]any{"state": state, "count": n})
	}

	return out
}

func rollupFixture(state string, runs, statuses map[string]int) map[string]any {
	return map[string]any{
		"state": state,
		"contexts": map[string]any{
			"checkRunCountsByState":      stateCounts(runs),
			"statusContextCountsByState": stateCounts(statuses),
		},
	}
}

func ciFromGraphQLRollup(t *testing.T, rollup map[string]any) dashboard.CIStatus {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "statusCheckRollup") {
			assert.Contains(t, body.Query, "checkRunCountsByState", "the query must ask for the per-state counts")
			assert.Contains(t, body.Query, "statusContextCountsByState")
		}
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
								"number": 516, "title": "release", "url": "https://github.com/alrayyes/a/pull/516",
								"isDraft": false, "author": map[string]any{"login": "ryankes"},
								"labels":    map[string]any{"nodes": []map[string]any{}},
								"createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
								"commits": map[string]any{"nodes": []map[string]any{
									{"commit": map[string]any{"statusCheckRollup": rollup}},
								}},
							}}},
							"issues": map[string]any{"nodes": []map[string]any{}},
						}},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())
	require.Len(t, result.PullRequests, 1)

	return result.PullRequests[0].CI
}

func TestFetch_RollupCI_CancelledRunWhileOthersRun(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		rollup   map[string]any
		expected dashboard.CIStatus
	}{
		{
			// alrayyes/Hush-Hush#516 at release 2.48.0: 1 cancelled, 22 queued, 1 skipped.
			name:     "Hush-Hush 516: stale cancelled run beside queued checks is pending",
			rollup:   rollupFixture("FAILURE", map[string]int{"CANCELLED": 1, "QUEUED": 22, "SKIPPED": 1, "FAILURE": 0}, map[string]int{"FAILURE": 0}),
			expected: dashboard.CIPending,
		},
		{
			name:     "cancelled beside in-progress is pending",
			rollup:   rollupFixture("FAILURE", map[string]int{"CANCELLED": 1, "IN_PROGRESS": 2}, nil),
			expected: dashboard.CIPending,
		},
		{
			name:     "real failure while others still run stays failure",
			rollup:   rollupFixture("FAILURE", map[string]int{"FAILURE": 1, "CANCELLED": 1, "QUEUED": 20}, nil),
			expected: dashboard.CIFailure,
		},
		{
			name:     "timed out while others run stays failure",
			rollup:   rollupFixture("FAILURE", map[string]int{"TIMED_OUT": 1, "IN_PROGRESS": 3}, nil),
			expected: dashboard.CIFailure,
		},
		{
			name:     "action required while others run stays failure",
			rollup:   rollupFixture("FAILURE", map[string]int{"ACTION_REQUIRED": 1, "QUEUED": 3}, nil),
			expected: dashboard.CIFailure,
		},
		{
			name:     "startup failure while others run stays failure",
			rollup:   rollupFixture("FAILURE", map[string]int{"STARTUP_FAILURE": 1, "QUEUED": 3}, nil),
			expected: dashboard.CIFailure,
		},
		{
			name:     "failed legacy status while checks run stays failure",
			rollup:   rollupFixture("FAILURE", map[string]int{"CANCELLED": 1, "QUEUED": 3}, map[string]int{"FAILURE": 1}),
			expected: dashboard.CIFailure,
		},
		{
			name:     "errored legacy status while checks run stays failure",
			rollup:   rollupFixture("ERROR", map[string]int{"QUEUED": 3}, map[string]int{"ERROR": 1}),
			expected: dashboard.CIFailure,
		},
		{
			name:     "cancelled only with nothing running stays failure",
			rollup:   rollupFixture("FAILURE", map[string]int{"CANCELLED": 1, "SUCCESS": 4, "SKIPPED": 1}, nil),
			expected: dashboard.CIFailure,
		},
		{
			name:     "cancelled beside a pending legacy status is pending",
			rollup:   rollupFixture("FAILURE", map[string]int{"CANCELLED": 1}, map[string]int{"PENDING": 1}),
			expected: dashboard.CIPending,
		},
		{
			name:     "rollup without counts keeps trusting the state",
			rollup:   map[string]any{"state": "FAILURE"},
			expected: dashboard.CIFailure,
		},
		{
			name:     "success stays success",
			rollup:   rollupFixture("SUCCESS", map[string]int{"SUCCESS": 5}, nil),
			expected: dashboard.CISuccess,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.expected, ciFromGraphQLRollup(t, tc.rollup))
		})
	}
}

func ciFromRESTCheckRuns(t *testing.T, runs []map[string]string) dashboard.CIStatus {
	t.Helper()

	return restPullRequest(t, runs).CI
}

// restPullRequest fetches the one pull request of the unauthenticated REST
// fallback's fixture.
func restPullRequest(t *testing.T, runs []map[string]string) dashboard.PullRequest {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/users/alrayyes/repos", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/a", "name": "a", "owner": map[string]string{"login": "alrayyes"}},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{{
			"number": 516, "title": "release", "html_url": "https://github.com/alrayyes/a/pull/516",
			"draft": false, "user": map[string]string{"login": "ryankes"},
			"labels":     []map[string]string{},
			"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
			"head": map[string]any{"sha": "cafef00d", "ref": "feat/child", "repo": map[string]string{"full_name": "alrayyes/a"}},
			"base": map[string]any{"ref": "feat/parent", "repo": map[string]string{"full_name": "alrayyes/a"}},
		}})
	})
	mux.HandleFunc("/repos/alrayyes/a/issues", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": runs})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result := github.NewClient("", "alrayyes", srv.URL).Fetch(t.Context())
	require.Len(t, result.PullRequests, 1)

	return result.PullRequests[0]
}

func TestFetch_NoToken_CheckRunCI_CancelledRunWhileOthersRun(t *testing.T) {
	t.Parallel()

	queued := func(n int) []map[string]string {
		out := make([]map[string]string, 0, n)
		for range n {
			out = append(out, map[string]string{"status": "queued"})
		}

		return out
	}
	done := func(conclusion string) map[string]string {
		return map[string]string{"status": "completed", "conclusion": conclusion}
	}

	tests := []struct {
		name     string
		runs     []map[string]string
		expected dashboard.CIStatus
	}{
		{
			name:     "Hush-Hush 516: cancelled, 22 queued, 1 skipped is pending",
			runs:     append(append([]map[string]string{done("cancelled")}, queued(22)...), done("skipped")),
			expected: dashboard.CIPending,
		},
		{
			name:     "real failure while others queue stays failure",
			runs:     append([]map[string]string{done("failure")}, queued(3)...),
			expected: dashboard.CIFailure,
		},
		{
			name:     "timed out while others queue stays failure",
			runs:     append(queued(3), done("timed_out")),
			expected: dashboard.CIFailure,
		},
		{
			name:     "cancelled only with nothing running stays failure",
			runs:     []map[string]string{done("cancelled"), done("success")},
			expected: dashboard.CIFailure,
		},
		{
			name:     "in progress alone is pending",
			runs:     []map[string]string{{"status": "in_progress"}, done("success")},
			expected: dashboard.CIPending,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.expected, ciFromRESTCheckRuns(t, tc.runs))
		})
	}
}

// The unauthenticated REST fallback carries the branches too (#860), and a
// head in another repository is a fork.
func TestFetch_NoToken_MapsTheBranches(t *testing.T) {
	t.Parallel()

	pr := restPullRequest(t, nil)

	assert.Equal(t, "feat/parent", pr.BaseBranch)
	assert.Equal(t, "feat/child", pr.HeadBranch)
	assert.False(t, pr.CrossRepository)
}

// The unauthenticated REST fallback carries the head SHA too (#759).
func TestFetch_NoToken_MapsTheHeadCommitSHA(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "cafef00d", restPullRequest(t, nil).HeadSHA)
}
