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

// statusAndReplacedServer plays a head with a replaced cancelled run (see
// replacedJobs) and one commit status, over both APIs.
func statusAndReplacedServer(t *testing.T, status string) *github.Client {
	t.Helper()

	runs := map[string]int{"CANCELLED": 1, "SUCCESS": 1}
	statuses := map[string]int{strings.ToUpper(status): 1}
	rollup := rollupFixture(githubRollupState(runs, statuses), runs, statuses)
	node := stalePRNode("CLEAN", "head", "head", rollup)
	node["commits"] = map[string]any{"nodes": []map[string]any{{"commit": map[string]any{
		"id": "C_head", "oid": "head", "statusCheckRollup": rollup,
	}}}}
	job := func(id, run int, conclusion string) map[string]any {
		j := finishedJob(id, run)
		j["name"], j["conclusion"] = "check", conclusion

		return j
	}
	run := func(id, number int, conclusion string) map[string]any {
		return map[string]any{
			"id": id, "name": "pr-title", "workflow_id": 1, "event": "pull_request",
			"run_number": number, "status": "completed", "conclusion": conclusion,
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(readGraphQLRequest(t, r).Query, "... on Commit") {
			writeJSON(t, w, map[string]any{"data": map[string]any{"nodes": []map[string]any{{
				"id":                "C_head",
				"statusCheckRollup": map[string]any{"contexts": map[string]any{"nodes": replacedJobs()}},
			}}}})

			return
		}
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{
			"pullRequests": map[string]any{"nodes": []map[string]any{node}},
			"issues":       map[string]any{"nodes": []map[string]any{}},
		}}})
	})
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "head"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/head/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": []map[string]any{job(1, 700, "cancelled"), job(2, 701, "success")}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/head/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"statuses": []map[string]any{commitStatus("deploy", status)}})
	})
	mux.HandleFunc("/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"workflow_runs": []map[string]any{
			run(700, 1, "cancelled"), run(701, 2, "success"),
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL)
}

// A commit status counts and is listed (#5101) while the replaced run is
// neither (#5116).
func TestCommitStatusesBesideAReplacedCancelledRun(t *testing.T) {
	t.Parallel()

	for status, want := range map[string]struct {
		ci     dashboard.CIStatus
		counts dashboard.CheckCounts
		listed string
	}{
		"success": {dashboard.CISuccess, dashboard.CheckCounts{Passed: 2}, "deploy success"},
		"failure": {dashboard.CIFailure, dashboard.CheckCounts{Passed: 1, Failed: 1}, "deploy failure"},
	} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			client := statusAndReplacedServer(t, status)

			pr := fetchHead(t, client)
			checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

			require.NoError(t, err)
			assert.Equal(t, want.ci, pr.CI)
			assert.Equal(t, want.counts, pr.Checks)
			assert.Equal(t, []string{"check success", want.listed}, namesAndStates(checks))
		})
	}
}
