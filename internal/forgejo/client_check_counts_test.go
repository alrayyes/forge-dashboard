package forgejo_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A pull request carries how many of its checks passed, are waiting and
// failed, tallied from the list of statuses the combined-status answer already
// holds, so it costs no extra request. Forgejo says pending for a check that is
// queued or running alike, so it counts as waiting and never as running.
func TestListOpenPullRequests_CarriesTheCheckCounts(t *testing.T) {
	t.Parallel()

	statuses := func(states ...string) []map[string]string {
		out := make([]map[string]string, 0, len(states))
		for _, s := range states {
			out = append(out, map[string]string{"status": s, "context": "ci/" + s})
		}

		return out
	}
	tests := []struct {
		name     string
		combined map[string]any
		want     dashboard.CheckCounts
	}{
		{
			name:     "passed, pending and failed statuses",
			combined: map[string]any{"state": "failure", "statuses": statuses("success", "success", "pending", "failure", "error")},
			want:     dashboard.CheckCounts{Passed: 2, Waiting: 1, Failed: 2},
		},
		{
			name:     "a warning counts as passed, as the combined state treats it",
			combined: map[string]any{"state": "warning", "statuses": statuses("success", "warning")},
			want:     dashboard.CheckCounts{Passed: 2},
		},
		{
			name:     "a skipped status counts as passed, and on its own as skipped",
			combined: map[string]any{"state": "success", "statuses": statuses("success", "skipped", "skipped")},
			want:     dashboard.CheckCounts{Passed: 3, Skipped: 2},
		},
		{
			name:     "a pipeline where every status was skipped is all passed and all skipped",
			combined: map[string]any{"state": "success", "statuses": statuses("skipped", "skipped")},
			want:     dashboard.CheckCounts{Passed: 2, Skipped: 2},
		},
		{
			name:     "no statuses means no checks",
			combined: map[string]any{"state": "", "statuses": []map[string]string{}},
			want:     dashboard.CheckCounts{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("page") != "1" {
					writeJSON(t, w, []map[string]any{})

					return
				}
				writeJSON(t, w, []map[string]any{{
					"number": 12, "title": "Add NTP alarm", "html_url": "https://git.example/alrayyes/a/pulls/12",
					"draft": false, "user": map[string]string{"login": "ryankes"},
					"labels": []map[string]string{}, "mergeable": true,
					"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
					"head": map[string]string{"sha": "cafef00d"},
					"base": map[string]string{"sha": "abc"},
				}})
			})
			mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(t, w, tt.combined)
			})
			srv := httptest.NewServer(mux)
			t.Cleanup(srv.Close)

			prs, err := forgejo.NewClient(srv.URL, "test-token", "").ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")

			require.NoError(t, err)
			require.Len(t, prs, 1)
			assert.Equal(t, tt.want, prs[0].Checks)
		})
	}
}

// The combined-status answer is one page of the commit's statuses (the SDK has
// no paging option for it), and the forge says how many there are in all in the
// X-Total-Count header. When the page holds fewer than that, a count of it
// would undercount, so the pull request carries none rather than a wrong one.
func TestListOpenPullRequests_ChecksOfAPageCappedStatusListAreUnknown(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{{
			"number": 12, "title": "Add NTP alarm", "html_url": "https://git.example/alrayyes/a/pulls/12",
			"draft": false, "user": map[string]string{"login": "ryankes"},
			"labels": []map[string]string{}, "mergeable": true,
			"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
			"head": map[string]string{"sha": "cafef00d"},
			"base": map[string]string{"sha": "abc"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Total-Count", "40")
		writeJSON(t, w, map[string]any{
			"state":    "failure",
			"statuses": []map[string]string{{"status": "success", "context": "a"}, {"status": "failure", "context": "b"}},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prs, err := forgejo.NewClient(srv.URL, "test-token", "").ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, prs, 1)
	assert.Equal(t, dashboard.CIFailure, prs[0].CI, "the overall state still comes from the combined state")
	assert.Equal(t, dashboard.CheckCounts{}, prs[0].Checks)
}

// Forgejo's combined status says pending for a check that is queued or running
// alike, so the statuses alone can't tell the two apart. When something is
// pending, the commit's Actions jobs say which is which (#2357): one running
// and one queued check read as 1 running and 1 queued, not 2 queued.
func TestListOpenPullRequests_ShowsARunningCheckAsRunning(t *testing.T) {
	t.Parallel()

	pending := []map[string]string{
		{"status": "success", "context": "lint"},
		{"status": "pending", "context": "test"},
		{"status": "pending", "context": "build"},
	}
	tests := []struct {
		name      string
		runsCode  int
		jobs      any
		want      dashboard.CheckCounts
		wantReads int
	}{
		{
			name: "one running and one queued job",
			jobs: []map[string]any{{"name": "test", "status": "running"}, {"name": "build", "status": "waiting"}},
			want: dashboard.CheckCounts{Passed: 1, Running: 1, Waiting: 1}, wantReads: 1,
		},
		{
			name: "the wrapped jobs answer reads the same",
			jobs: map[string]any{"jobs": []map[string]any{{"name": "test", "status": "running"}, {"name": "build", "status": "running"}}},
			want: dashboard.CheckCounts{Passed: 1, Running: 2}, wantReads: 1,
		},
		{
			name: "more running jobs than pending statuses never exceed the pending ones",
			jobs: []map[string]any{{"status": "running"}, {"status": "running"}, {"status": "running"}},
			want: dashboard.CheckCounts{Passed: 1, Running: 2}, wantReads: 1,
		},
		{
			name:     "an instance without the runs route keeps the pending ones queued",
			runsCode: http.StatusNotFound,
			want:     dashboard.CheckCounts{Passed: 1, Waiting: 2},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var jobReads atomic.Int32
			mux := http.NewServeMux()
			mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("page") != "1" {
					writeJSON(t, w, []map[string]any{})

					return
				}
				writeJSON(t, w, []map[string]any{{
					"number": 12, "title": "Add NTP alarm", "html_url": "https://git.example/alrayyes/a/pulls/12",
					"user": map[string]string{"login": "ryankes"}, "labels": []map[string]string{}, "mergeable": true,
					"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
					"head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"sha": "abc"},
				}})
			})
			mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(t, w, map[string]any{"state": "pending", "statuses": pending})
			})
			mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, r *http.Request) {
				if tt.runsCode != 0 {
					w.WriteHeader(tt.runsCode)

					return
				}
				assert.Equal(t, "cafef00d", r.URL.Query().Get("head_sha"))
				writeJSON(t, w, map[string]any{"workflow_runs": []map[string]any{
					{"id": 7, "status": "running", "commit_sha": "cafef00d"},
				}})
			})
			mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/7/jobs", func(w http.ResponseWriter, _ *http.Request) {
				jobReads.Add(1)
				writeJSON(t, w, tt.jobs)
			})
			srv := httptest.NewServer(mux)
			t.Cleanup(srv.Close)

			prs, err := forgejo.NewClient(srv.URL, "test-token", "").ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")

			require.NoError(t, err)
			require.Len(t, prs, 1)
			assert.Equal(t, tt.want, prs[0].Checks)
			assert.EqualValues(t, tt.wantReads, jobReads.Load(), "one jobs read per run still going, none when nothing is pending")
		})
	}
}

// A failed runs-list read keeps the pending ones queued, and it still lands in
// the request log, so a forge refusing the route shows up there and not only
// at debug level.
func TestListOpenPullRequests_RecordsAFailedRunsListRequest(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{{
			"number": 12, "title": "Add NTP alarm", "html_url": "https://git.example/alrayyes/a/pulls/12",
			"user": map[string]string{"login": "ryankes"}, "labels": []map[string]string{}, "mergeable": true,
			"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
			"head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"sha": "abc"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "pending", "statuses": []map[string]string{{"status": "pending", "context": "test"}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	rec := &fakeRecorder{}

	prs, err := forgejo.NewClient(srv.URL, "test-token", "", rec).ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, prs, 1)
	assert.Equal(t, dashboard.CheckCounts{Waiting: 1}, prs[0].Checks)
	var failed []string
	for _, e := range rec.all() {
		if e.Outcome != requestlog.OutcomeSuccess && strings.Contains(e.Endpoint, "/actions/") {
			failed = append(failed, e.Endpoint)
		}
	}
	assert.Equal(t, []string{"/repos/alrayyes/a/actions/runs"}, failed)
}
