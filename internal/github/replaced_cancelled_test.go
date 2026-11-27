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

// rollupJob is one check run of a head commit, as the rollup lists it. An empty
// conclusion is a run still going.
func rollupJob(workflow, name string, number int, conclusion string) map[string]any {
	status := "COMPLETED"
	if conclusion == "" {
		status = "IN_PROGRESS"
	}

	return map[string]any{
		"__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion,
		"checkSuite": map[string]any{"workflowRun": map[string]any{
			"databaseId": 1000 + number, "runAttempt": 1, "runNumber": number,
			"workflow": map[string]any{"name": workflow},
		}},
	}
}

// headServer serves one pull request whose head has the given check runs: the
// rollup counts them on the pull request, and lists them when asked by commit.
type headServer struct {
	jobs  []map[string]any
	fails bool
	reads atomic.Int32
}

func (s *headServer) node() map[string]any {
	runs := map[string]int{}
	for _, j := range s.jobs {
		state, _ := j["conclusion"].(string)
		if state == "" {
			state, _ = j["status"].(string)
		}
		runs[state]++
	}
	rollup := rollupFixture(githubRollupState(runs, nil), runs, nil)
	node := stalePRNode("CLEAN", "head", "head", rollup)
	node["commits"] = map[string]any{"nodes": []map[string]any{{"commit": map[string]any{
		"id": "C_head", "oid": "head", "statusCheckRollup": rollup,
	}}}}

	return node
}

func (s *headServer) start(t *testing.T) *github.Client {
	t.Helper()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "... on Commit") {
			s.reads.Add(1)
			if s.fails {
				writeJSON(t, w, map[string]any{"errors": []map[string]any{{"message": "boom"}}})

				return
			}
			assert.Equal(t, []any{"C_head"}, body.Variables["ids"])
			writeJSON(t, w, map[string]any{"data": map[string]any{"nodes": []map[string]any{{
				"id":                "C_head",
				"statusCheckRollup": map[string]any{"contexts": map[string]any{"nodes": s.jobs}},
			}}}})

			return
		}
		if strings.Contains(body.Query, "statusCheckRollup") {
			assert.Regexp(t, `commit \{\s+id\s+oid`, body.Query, "the head commit's id is asked for")
		}
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{
			"pullRequests": map[string]any{"nodes": []map[string]any{s.node()}},
			"issues":       map[string]any{"nodes": []map[string]any{}},
		}}})
	}))
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL)
}

func fetchHead(t *testing.T, client *github.Client) dashboard.PullRequest {
	t.Helper()

	prs, _, err := client.FetchRepo(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	require.Len(t, prs, 1)

	return prs[0]
}

func TestPullRequestRow_ACancelledRunALaterRunReplaced(t *testing.T) {
	t.Parallel()

	cancelled := rollupJob("pr-title", "check", 1, "CANCELLED")
	for name, tc := range map[string]struct {
		other  map[string]any
		ci     dashboard.CIStatus
		counts dashboard.CheckCounts
	}{
		"passed reads passed": {
			rollupJob("pr-title", "check", 2, "SUCCESS"), dashboard.CISuccess, dashboard.CheckCounts{Passed: 1},
		},
		"failed reads failed": {
			rollupJob("pr-title", "check", 2, "FAILURE"), dashboard.CIFailure, dashboard.CheckCounts{Failed: 1},
		},
		"going reads running": {
			rollupJob("pr-title", "check", 2, ""), dashboard.CIPending, dashboard.CheckCounts{Running: 1},
		},
		"another workflow's job leaves it cancelled": {
			rollupJob("other", "check", 2, "SUCCESS"), ciCancelled, dashboard.CheckCounts{Passed: 1, Cancelled: 1},
		},
		"another job of the workflow leaves it cancelled": {
			rollupJob("pr-title", "lint", 2, "SUCCESS"), ciCancelled, dashboard.CheckCounts{Passed: 1, Cancelled: 1},
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			pr := fetchHead(t, (&headServer{jobs: []map[string]any{cancelled, tc.other}}).start(t))

			assert.Equal(t, tc.ci, pr.CI)
			assert.Equal(t, tc.counts, pr.Checks)
		})
	}
}

func replacedJobs() []map[string]any {
	return []map[string]any{
		rollupJob("pr-title", "check", 1, "CANCELLED"), rollupJob("pr-title", "check", 2, "SUCCESS"),
	}
}

func TestPullRequestRow_ReadsTheHeadsChecksOnlyWhenItMust(t *testing.T) {
	t.Parallel()

	t.Run("not with nothing cancelled", func(t *testing.T) {
		t.Parallel()
		srv := &headServer{jobs: []map[string]any{rollupJob("ci", "test", 1, "SUCCESS")}}

		fetchHead(t, srv.start(t))

		assert.Zero(t, srv.reads.Load())
	})

	t.Run("not with nothing that could have replaced one", func(t *testing.T) {
		t.Parallel()
		srv := &headServer{jobs: []map[string]any{rollupJob("ci", "test", 1, "CANCELLED")}}

		assert.Equal(t, ciCancelled, fetchHead(t, srv.start(t)).CI)
		assert.Zero(t, srv.reads.Load())
	})

	t.Run("once while the head's counts stand", func(t *testing.T) {
		t.Parallel()
		srv := &headServer{jobs: replacedJobs()}
		client := srv.start(t)

		fetchHead(t, client)
		second := fetchHead(t, client)

		assert.Equal(t, dashboard.CISuccess, second.CI)
		assert.EqualValues(t, 1, srv.reads.Load())
	})

	t.Run("a failed read leaves the row as GitHub gave it and asks again", func(t *testing.T) {
		t.Parallel()
		srv := &headServer{fails: true, jobs: replacedJobs()}
		client := srv.start(t)

		fetchHead(t, client)

		assert.Equal(t, ciCancelled, fetchHead(t, client).CI)
		assert.EqualValues(t, 2, srv.reads.Load())
	})
}

// The tokenless REST fallback has no counts, only the row's overall state.
func TestFetchREST_ACancelledRunALaterRunReplaced(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct {
		second string
		ci     dashboard.CIStatus
	}{
		"reads passed": {"pr-title", dashboard.CISuccess},
		"stays cancelled beside another workflow's job": {"other", ciCancelled},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			commit := replacedServer(t, "pr-title", tc.second).Config.Handler
			mux := http.NewServeMux()
			mux.HandleFunc("/users/alrayyes/repos", func(w http.ResponseWriter, r *http.Request) {
				if page := r.URL.Query().Get("page"); page != "" && page != "1" {
					writeJSON(t, w, []map[string]any{})

					return
				}
				writeJSON(t, w, []map[string]any{{"full_name": "alrayyes/a", "name": "a", "owner": map[string]string{"login": "alrayyes"}}})
			})
			mux.HandleFunc("/repos/alrayyes/a/pulls", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(t, w, []map[string]any{{"number": 5, "head": map[string]string{"sha": "cafef00d"}}})
			})
			mux.HandleFunc("/repos/alrayyes/a/issues", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(t, w, []map[string]any{})
			})
			mux.Handle("/", commit)
			srv := httptest.NewServer(mux)
			t.Cleanup(srv.Close)

			result := github.NewClient("", "alrayyes", srv.URL).Fetch(t.Context())

			require.Len(t, result.PullRequests, 1)
			assert.Equal(t, tc.ci, result.PullRequests[0].CI)
		})
	}
}

// replacedServer plays the REST API for pull request 5, whose head has a
// cancelled job of run 1 and a passed job of run 2 of the workflows named.
func replacedServer(t *testing.T, first, second string) *httptest.Server {
	t.Helper()

	job := func(id, run int, conclusion string) map[string]any {
		j := finishedJob(id, run)
		j["name"], j["conclusion"] = "check", conclusion

		return j
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": []map[string]any{job(1, 700, "cancelled"), job(2, 701, "success")}})
	})
	mux.HandleFunc("/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"workflow_runs": []map[string]any{
			{"id": 700, "name": first, "run_number": 1, "status": "completed", "conclusion": "cancelled"},
			{"id": 701, "name": second, "run_number": 2, "status": "completed", "conclusion": "success"},
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

// The dialog lists what the row counts.
func TestListChecks_ACancelledRunALaterRunReplaced(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct {
		second string
		listed int
	}{
		"is left out":                         {"pr-title", 1},
		"stays beside another workflow's job": {"other", 2},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			client := github.NewClient("test-token", "", replacedServer(t, "pr-title", tc.second).URL)

			checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
			require.NoError(t, err)

			assert.Len(t, checks, tc.listed)
		})
	}
}
