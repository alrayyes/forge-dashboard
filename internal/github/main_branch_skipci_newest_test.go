package github_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A release bot's "[skip ci]" commit has no checks, so the row walks back to the
// commit before it. That commit's older failed run must not outlive the newer
// run that passed, so the walk-back reads the same run facts the head does.
func TestFetch_MainBranch_ACommitFoundBehindASkipCiCommitReadsItsNewestRun(t *testing.T) {
	t.Parallel()

	push := workflowRun(1, 1, 5, "ci")
	dispatched := workflowRun(2, 1, 6, "ci")
	checked := map[string]any{
		"oid": "322ca560e61ef0378ee010d60c6c71df9aff2650", "abbreviatedOid": "322ca56",
		"messageHeadline": "fix: a thing", "url": "https://github.com/alrayyes/a/commit/322ca56",
		"committedDate": "2026-10-09T09:00:00Z",
		"statusCheckRollup": rollupOf("FAILURE", map[string]int{"FAILURE": 1},
			runCheck(12, "reports", "COMPLETED", "FAILURE", "2026-10-09T09:01:00Z", "2026-10-09T09:03:00Z", runsURL+"1/job/12", suiteOf("COMPLETED", "FAILURE", push))),
		"checkSuites": map[string]any{"nodes": []map[string]any{
			suiteNode("S1", "COMPLETED", "FAILURE", push), suiteNode("S2", "COMPLETED", "SUCCESS", dispatched),
		}},
	}
	skipCI := map[string]any{
		"oid": "d77a71648ce53adf4e77dc02ce7c434f55538953", "abbreviatedOid": "d77a716",
		"messageHeadline": "chore(release): 2.6.2 [skip ci]", "url": "https://github.com/alrayyes/a/commit/d77a716",
		"committedDate": "2026-10-09T09:10:00Z", "statusCheckRollup": nil,
	}

	var mu sync.Mutex
	var historyQuery string
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		query := readGraphQLRequest(t, r).Query
		rate := map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"}
		switch {
		case strings.Contains(query, "history("):
			mu.Lock()
			historyQuery = query
			mu.Unlock()
			writeJSON(t, w, map[string]any{"data": map[string]any{"rateLimit": rate, "m0": map[string]any{
				"defaultBranchRef": map[string]any{"target": map[string]any{
					"history": map[string]any{"nodes": []map[string]any{skipCI, checked}},
				}},
			}}})
		case strings.Contains(query, "nodes(ids"):
			writeJSON(t, w, map[string]any{"data": map[string]any{"nodes": []map[string]any{{
				"id": "S2", "checkRuns": map[string]any{"nodes": []map[string]any{
					runCheck(22, "reports", "COMPLETED", "SUCCESS", "2026-10-09T10:01:00Z", "2026-10-09T10:03:00Z", runsURL+"2/job/22", suiteOf("COMPLETED", "SUCCESS", dispatched)),
				}},
			}}}})
		default:
			head := branchRef(nil)
			head["target"] = skipCI
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
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.MainBranches, 1)
	assert.Equal(t, dashboard.MainBranchPassed, result.MainBranches[0].Status)
	mu.Lock()
	defer mu.Unlock()
	assert.Contains(t, historyQuery, "checkSuites(last: 50)", "the walk-back asks for the commit's suites")
	assert.Contains(t, historyQuery, "contexts(first: 100)", "and as many checks as the head read does")
	assert.Contains(t, historyQuery, "workflowRun", "and the run each check belongs to")
}
