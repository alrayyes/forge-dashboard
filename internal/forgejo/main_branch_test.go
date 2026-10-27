package forgejo_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ dashboard.MainBranchReader = (*forgejo.Client)(nil)

// actionRun is one run as a real Forgejo lists it: commit_sha, prettyref (the
// branch, or "#N" for a pull request), title, workflow_id, started and stopped,
// not the GitHub-style head_sha and head_branch (#1264).
func actionRun(id int, branch, sha, status, started, completed string) map[string]any {
	return map[string]any{
		"id": id, "prettyref": branch, "commit_sha": sha, "status": status, "event": "push",
		"workflow_id": "ci.yaml", "title": "title of " + sha,
		"html_url":     "https://forge.example/alrayyes/a/actions/runs/" + strconv.Itoa(id),
		"trigger_user": map[string]any{"login": "bot"}, "started": started, "stopped": completed,
	}
}

// mainBranchServer plays Forgejo for repo alrayyes/a: runs is what the runs
// list answers (newest first), jobs maps a run id to its jobs, and a nil
// commit makes the commit route fail.
type mainBranchServer struct {
	runs     []map[string]any
	runsCode int
	jobs     map[string][]map[string]any
	jobsCode int
	// jobsFail makes the jobs route answer with that status for one run id.
	jobsFail map[string]int
	bareJobs bool // answer the jobs list as a bare array, as the live instance does
	commit   map[string]any

	mu    sync.Mutex
	query map[string]string
	paths []string
}

func (s *mainBranchServer) start(t *testing.T) *forgejo.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		s.serveRuns(t, w, r)
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"name": "a", "full_name": "alrayyes/a", "default_branch": "main"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/{run}/jobs", func(w http.ResponseWriter, r *http.Request) {
		s.serveJobs(t, w, r)
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/git/commits/{sha}", func(w http.ResponseWriter, _ *http.Request) {
		if s.commit == nil {
			w.WriteHeader(http.StatusNotFound)

			return
		}
		writeJSON(t, w, s.commit)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func (s *mainBranchServer) serveRuns(t *testing.T, w http.ResponseWriter, r *http.Request) {
	t.Helper()

	s.mu.Lock()
	s.paths = append(s.paths, r.URL.Path)
	s.query = map[string]string{"branch": r.URL.Query().Get("branch")}
	s.mu.Unlock()
	if s.runsCode != 0 {
		w.WriteHeader(s.runsCode)

		return
	}
	runs := s.runs
	if sha := r.URL.Query().Get("head_sha"); sha != "" {
		// Forgejo filters by commit here; the branch filter it ignores.
		runs = nil
		for _, run := range s.runs {
			if run["commit_sha"] == sha {
				runs = append(runs, run)
			}
		}
	}
	writeJSON(t, w, map[string]any{"total_count": len(runs), "workflow_runs": runs})
}

func (s *mainBranchServer) serveJobs(t *testing.T, w http.ResponseWriter, r *http.Request) {
	t.Helper()

	s.mu.Lock()
	s.paths = append(s.paths, r.URL.Path)
	s.mu.Unlock()
	if s.jobsCode != 0 {
		w.WriteHeader(s.jobsCode)

		return
	}
	if code := s.jobsFail[r.PathValue("run")]; code != 0 {
		w.WriteHeader(code)

		return
	}
	if s.bareJobs {
		writeJSON(t, w, s.jobs[r.PathValue("run")])

		return
	}
	writeJSON(t, w, map[string]any{"total_count": 1, "jobs": s.jobs[r.PathValue("run")]})
}

func (s *mainBranchServer) branchParam() string {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.query["branch"]
}

func (s *mainBranchServer) requests() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]string(nil), s.paths...)
}

var repoA = dashboard.RepoRef{FullName: "alrayyes/a", Owner: "alrayyes", Name: "a", URL: "https://forge.example/alrayyes/a", DefaultBranch: "main"}

func goodCommit() map[string]any {
	return map[string]any{
		"sha": "cafef00dcafef00d", "html_url": "https://forge.example/alrayyes/a/commit/cafef00d",
		"commit": map[string]any{
			"message": "fix: stop the thing\n\nlonger body", "author": map[string]any{"name": "Ryan Kes", "date": "2026-10-10T09:00:00Z"},
		},
		"author": map[string]any{"login": "ryankes"},
	}
}

func TestReadMainBranch(t *testing.T) {
	t.Parallel()

	t.Run("a failed run fails the branch and names the failed job", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			runs: []map[string]any{
				actionRun(3, "main", "cafef00dcafef00d", "failure", "2026-10-10T09:01:00Z", "2026-10-10T09:05:00Z"),
				actionRun(2, "main", "cafef00dcafef00d", "success", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z"),
				actionRun(1, "main", "oldoldold", "success", "2026-10-09T09:01:00Z", "2026-10-09T09:02:00Z"),
			},
			jobs:   map[string][]map[string]any{"3": {{"name": "test", "status": "failure"}, {"name": "lint", "status": "success"}}},
			commit: goodCommit(),
		}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.MainBranchFailed, row.Status)
		assert.Equal(t, []string{"test"}, row.FailingJobs)
		assert.Equal(t, "https://forge.example/alrayyes/a/actions/runs/3", row.RunURL, "the failed run's page")
		assert.Equal(t, "main", row.Branch)
	})

	t.Run("asks for the default branch, and ignores runs of other branches", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			runs: []map[string]any{
				actionRun(1, "feature", "feedface", "failure", "2026-10-10T10:00:00Z", "2026-10-10T10:05:00Z"),
				actionRun(2, "main", "cafef00dcafef00d", "success", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z"),
			},
			commit: goodCommit(),
		}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.MainBranchPassed, row.Status, "the feature branch's failure is not main's")
		assert.Equal(t, "main", s.branchParam())
	})

	t.Run("the commit comes from the commit itself", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			runs:   []map[string]any{actionRun(1, "main", "cafef00dcafef00d", "success", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z")},
			commit: goodCommit(),
		}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		require.NotNil(t, row.Commit)
		assert.Equal(t, "cafef00", row.Commit.SHA)
		assert.Equal(t, "fix: stop the thing", row.Commit.Subject, "the first line")
		assert.Equal(t, "ryankes", row.Commit.Author, "the login, not the name on the commit")
		assert.Equal(t, time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC), *row.Commit.CommittedAt)
	})

	t.Run("a commit that can't be read falls back to the run's title and actor", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{runs: []map[string]any{actionRun(1, "main", "cafef00dcafef00d", "success", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z")}}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		require.NotNil(t, row.Commit)
		assert.Equal(t, "cafef00", row.Commit.SHA)
		assert.Equal(t, "title of cafef00dcafef00d", row.Commit.Subject)
		assert.Equal(t, "bot", row.Commit.Author)
	})

	t.Run("a finished pipeline says when it ended and how long it took", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{runs: []map[string]any{
			actionRun(1, "main", "cafef00d", "success", "2026-10-10T09:01:30Z", "2026-10-10T09:05:30Z"),
			actionRun(2, "main", "cafef00d", "success", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z"),
		}}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		require.NotNil(t, row.FinishedAt)
		assert.Equal(t, time.Date(2026, 10, 10, 9, 5, 30, 0, time.UTC), *row.FinishedAt)
		require.NotNil(t, row.DurationSeconds)
		assert.Equal(t, 270, *row.DurationSeconds)
	})

	t.Run("cancelled runs alone are cancelled, name no job and link the cancelled run (#1950)", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{runs: []map[string]any{
			actionRun(1, "main", "cafef00d", "cancelled", "2026-10-10T09:01:00Z", "2026-10-10T09:01:05Z"),
			actionRun(2, "main", "cafef00d", "success", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z"),
		}}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.MainBranchCancelled, row.Status)
		assert.NotNil(t, row.FailingJobs, "an array, never null")
		assert.Empty(t, row.FailingJobs)
		assert.Contains(t, row.RunURL, "/actions/runs/1")
	})

	t.Run("a run started at the Unix epoch has no duration", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{runs: []map[string]any{
			actionRun(1, "main", "cafef00d", "failure", "1970-01-01T00:00:00Z", "2026-10-10T09:02:00Z"),
		}}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Nil(t, row.DurationSeconds, "an epoch start is an unset start, not 56 years of running")
	})

	t.Run("a run still going is running, with no finish time", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{runs: []map[string]any{
			actionRun(1, "main", "cafef00d", "running", "2026-10-10T09:01:00Z", "0001-01-01T00:00:00Z"),
			actionRun(2, "main", "cafef00d", "success", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z"),
		}}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.MainBranchRunning, row.Status)
		assert.Nil(t, row.FinishedAt)
		assert.Nil(t, row.DurationSeconds)
	})

	t.Run("a failure wins over a run still going", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{runs: []map[string]any{
			actionRun(1, "main", "cafef00d", "running", "2026-10-10T09:01:00Z", "0001-01-01T00:00:00Z"),
			actionRun(2, "main", "cafef00d", "failure", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z"),
		}}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.MainBranchFailed, row.Status)
	})

	t.Run("a failed run whose jobs can't be read is named by its workflow", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			runs:     []map[string]any{actionRun(1, "main", "cafef00d", "failure", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z")},
			jobsCode: http.StatusInternalServerError,
		}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.MainBranchFailed, row.Status)
		assert.Equal(t, []string{"ci.yaml"}, row.FailingJobs)
	})

	t.Run("a repo with no run on its default branch has no pipeline", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{runs: []map[string]any{}}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.MainBranchNone, row.Status)
		assert.Equal(t, "main", row.Branch)
		assert.Nil(t, row.Commit)
		assert.Equal(t, repoA.URL, row.RunURL)
		assert.NotNil(t, row.FailingJobs)
	})

	t.Run("an instance without Actions has no pipeline, not an error", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{runsCode: http.StatusNotFound}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.MainBranchNone, row.Status)
	})

	t.Run("a runs list that fails is an error, so the old row is kept", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{runsCode: http.StatusInternalServerError}
		client := s.start(t)

		_, err := client.ReadMainBranch(t.Context(), repoA)

		require.Error(t, err)
	})

	t.Run("a repo with no default branch makes no request", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{}
		client := s.start(t)
		repo := repoA
		repo.DefaultBranch = ""

		row, err := client.ReadMainBranch(t.Context(), repo)

		require.NoError(t, err)
		assert.Equal(t, dashboard.MainBranchNone, row.Status)
		assert.Empty(t, s.requests())
	})
}

func TestReadMainBranch_RealResponse(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("testdata/actions_runs_master.json")
	require.NoError(t, err)
	var list struct {
		Runs []map[string]any `json:"workflow_runs"`
	}
	require.NoError(t, json.Unmarshal(raw, &list))
	s := &mainBranchServer{runs: list.Runs, commit: goodCommit()}
	client := s.start(t)

	row, err := client.ReadMainBranch(t.Context(), dashboard.RepoRef{
		FullName: "alrayyes/a", Owner: "alrayyes", Name: "a", URL: "https://forge.example/alrayyes/a", DefaultBranch: "master",
	})

	require.NoError(t, err)
	assert.Equal(t, dashboard.MainBranchPassed, row.Status, "older failures and pull request runs are not master's newest commit")
}

func TestReadMainBranch_EachStatus(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		statuses []string
		want     dashboard.MainBranchStatus
	}{
		{"success", []string{"success"}, dashboard.MainBranchPassed},
		{"failure", []string{"failure"}, dashboard.MainBranchFailed},
		{"cancelled alone", []string{"cancelled"}, dashboard.MainBranchCancelled},
		{"cancelled beside a success", []string{"cancelled", "success"}, dashboard.MainBranchCancelled},
		{"cancelled beside a failure", []string{"cancelled", "failure"}, dashboard.MainBranchFailed},
		{"cancelled beside a run still going", []string{"cancelled", "running"}, dashboard.MainBranchRunning},
		{"skipped alone", []string{"skipped"}, dashboard.MainBranchPassed},
		{"running", []string{"running"}, dashboard.MainBranchRunning},
		{"waiting", []string{"waiting"}, dashboard.MainBranchRunning},
		{"skipped beside successes", []string{"success", "skipped", "success"}, dashboard.MainBranchPassed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			s := &mainBranchServer{}
			for i, st := range tc.statuses {
				s.runs = append(s.runs, actionRun(10-i, "main", "cafef00d", st, "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z"))
			}
			client := s.start(t)

			row, err := client.ReadMainBranch(t.Context(), repoA)

			require.NoError(t, err)
			assert.Equal(t, tc.want, row.Status)
		})
	}
}

func TestListRepos_CarriesTheDefaultBranch(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/a", "name": "a", "default_branch": "trunk", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": true}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	repos, err := forgejo.NewClient(srv.URL, "test-token", "").ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, "trunk", repos[0].DefaultBranch)
}

// A run whose jobs can't be listed (none served here) counts as one check by
// its own status, so these are the fallback counts; the job counts are in
// main_branch_job_counts_test.go. A cancelled run is in none of the four, as
// for a pull request.
func TestReadMainBranch_FallsBackToTheRunCounts(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		statuses []string
		want     dashboard.CheckCounts
	}{
		{"mixed", []string{"success", "skipped", "running", "waiting", "blocked", "failure"}, dashboard.CheckCounts{Passed: 2, Skipped: 1, Running: 1, Waiting: 2, Failed: 1}},
		{"every run skipped", []string{"skipped", "skipped"}, dashboard.CheckCounts{Passed: 2, Skipped: 2}},
		{"all passed", []string{"success", "success", "success"}, dashboard.CheckCounts{Passed: 3}},
		{"cancelled counts in none", []string{"success", "cancelled"}, dashboard.CheckCounts{Passed: 1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			s := &mainBranchServer{}
			for i, st := range tc.statuses {
				s.runs = append(s.runs, actionRun(20-i, "main", "cafef00d", st, "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z"))
			}
			client := s.start(t)

			row, err := client.ReadMainBranch(t.Context(), repoA)

			require.NoError(t, err)
			assert.Equal(t, tc.want, row.Checks)
		})
	}

	t.Run("a repo with no run has all zero", func(t *testing.T) {
		t.Parallel()
		client := (&mainBranchServer{}).start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.CheckCounts{}, row.Checks)
	})
}
