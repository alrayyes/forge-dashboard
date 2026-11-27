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
			"event":    "pull_request",
			"workflow": map[string]any{"databaseId": workflowID(workflow), "name": workflow},
		}},
	}
}

// workflowID gives each workflow the fixtures name an id of its own.
func workflowID(name string) int {
	if name == "pr-title" {
		return 1
	}

	return 2
}

// jobRunOf is the workflow run of a rollupJob, for a case to change.
func jobRunOf(job map[string]any) map[string]any {
	suite, _ := job["checkSuite"].(map[string]any)
	run, _ := suite["workflowRun"].(map[string]any)

	return run
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
	otherFile := rollupJob("pr-title", "check", 2, "SUCCESS")
	jobRunOf(otherFile)["workflow"] = map[string]any{"databaseId": 9, "name": "pr-title"}
	otherEvent := rollupJob("pr-title", "check", 2, "SUCCESS")
	jobRunOf(otherEvent)["event"] = "push"
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
		"skipped leaves it cancelled": {
			rollupJob("pr-title", "check", 2, "SKIPPED"), ciCancelled,
			dashboard.CheckCounts{Passed: 1, Skipped: 1, Cancelled: 1},
		},
		"neutral leaves it cancelled": {
			rollupJob("pr-title", "check", 2, "NEUTRAL"), ciCancelled, dashboard.CheckCounts{Passed: 1, Cancelled: 1},
		},
		"another workflow file of the same name leaves it cancelled": {
			otherFile, ciCancelled, dashboard.CheckCounts{Passed: 1, Cancelled: 1},
		},
		"another event's run leaves it cancelled": {
			otherEvent, ciCancelled, dashboard.CheckCounts{Passed: 1, Cancelled: 1},
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

// A check nobody can grade is left once the replaced run is gone.
func TestPullRequestRow_AReplacedRunBesideAnUngradedCheck(t *testing.T) {
	t.Parallel()

	jobs := append(replacedJobs(), rollupJob("ci", "test", 1, "SOMETHING_NEW"))

	pr := fetchHead(t, (&headServer{jobs: jobs}).start(t))

	assert.Equal(t, dashboard.CIPending, pr.CI)
	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Unknown: 1}, pr.Checks)
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
		later laterRun
		ci    dashboard.CIStatus
	}{
		"reads passed": {passedLater, dashboard.CISuccess},
		"stays cancelled beside another workflow's job": {
			laterRun{"other", 2, "pull_request", "success"}, ciCancelled,
		},
		"stays cancelled beside another workflow file of the same name": {
			laterRun{"pr-title", 9, "pull_request", "success"}, ciCancelled,
		},
		"stays cancelled beside another event's run": {
			laterRun{"pr-title", 1, "push", "success"}, ciCancelled,
		},
		"stays cancelled beside a skipped run": {
			laterRun{"pr-title", 1, "pull_request", "skipped"}, ciCancelled,
		},
		"stays cancelled beside a neutral run": {
			laterRun{"pr-title", 1, "pull_request", "neutral"}, ciCancelled,
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			commit := replacedServer(t, tc.later).Config.Handler
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

// laterRun is the run after the cancelled one, and how its job ended.
type laterRun struct {
	name       string
	workflow   int
	event      string
	conclusion string
}

var passedLater = laterRun{"pr-title", 1, "pull_request", "success"}

// replacedServer plays the REST API for pull request 5, whose head has a
// cancelled job of pr-title's run 1 and a job of the later run 2.
func replacedServer(t *testing.T, later laterRun) *httptest.Server {
	t.Helper()

	job := func(id, run int, conclusion string) map[string]any {
		j := finishedJob(id, run)
		j["name"], j["conclusion"] = "check", conclusion

		return j
	}
	run := func(id, number int, r laterRun) map[string]any {
		return map[string]any{
			"id": id, "name": r.name, "workflow_id": r.workflow, "event": r.event,
			"run_number": number, "status": "completed", "conclusion": r.conclusion,
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": []map[string]any{job(1, 700, "cancelled"), job(2, 701, later.conclusion)}})
	})
	mux.HandleFunc("/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"workflow_runs": []map[string]any{
			run(700, 1, laterRun{"pr-title", 1, "pull_request", "cancelled"}), run(701, 2, later),
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
		later  laterRun
		listed int
	}{
		"is left out":                                         {passedLater, 1},
		"stays beside another workflow's job":                 {laterRun{"other", 2, "pull_request", "success"}, 2},
		"stays beside another workflow file of the same name": {laterRun{"pr-title", 9, "pull_request", "success"}, 2},
		"stays beside another event's run":                    {laterRun{"pr-title", 1, "push", "success"}, 2},
		"stays beside a skipped run":                          {laterRun{"pr-title", 1, "pull_request", "skipped"}, 2},
		"stays beside a neutral run":                          {laterRun{"pr-title", 1, "pull_request", "neutral"}, 2},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			client := github.NewClient("test-token", "", replacedServer(t, tc.later).URL)

			checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
			require.NoError(t, err)

			assert.Len(t, checks, tc.listed)
		})
	}
}
