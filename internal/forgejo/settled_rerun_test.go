package forgejo_test

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// rerunForge is a fake Forgejo with one repository and one open pull request,
// whose commit statuses a test can change the way a rerun changes them. It
// records every request it is sent.
type rerunForge struct {
	mu       sync.Mutex
	statuses []map[string]any
	nextID   int
	requests []string
	// statusDown makes the combined status answer a 500.
	statusDown bool
	// pageSize splits the statuses into pages of this many, or 0 for one page.
	pageSize int
}

const rerunStatusPath = "/api/v1/repos/alrayyes/a/commits/cafef00d/status"

// post records a new status for context, which replaces the context's earlier
// one in the combined status and carries a higher id, as Forgejo's do.
func (f *rerunForge) post(context, state string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	f.statuses = slices.DeleteFunc(f.statuses, func(s map[string]any) bool { return s["context"] == context })
	f.statuses = append(f.statuses, map[string]any{"id": f.nextID, "context": context, "status": state})
}

func (f *rerunForge) setStatusDown(down bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statusDown = down
}

// take returns the requests sent since the last take.
func (f *rerunForge) take() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	got := f.requests
	f.requests = nil

	return got
}

func (f *rerunForge) combined() (map[string]any, int, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	state := "success"
	for _, s := range f.statuses {
		if s["status"] == "failure" {
			state = "failure"

			break
		}
		if s["status"] == "pending" {
			state = "pending"
		}
	}
	statuses := slices.Clone(f.statuses)

	return map[string]any{"state": state, "statuses": statuses}, len(statuses), f.statusDown
}

func (f *rerunForge) aggregator(t *testing.T, opts ...dashboard.AggregatorOption) *dashboard.Aggregator {
	t.Helper()
	mux := http.NewServeMux()
	onePage := func(w http.ResponseWriter, r *http.Request, rows []map[string]any) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			rows = []map[string]any{}
		}
		writeJSON(t, w, rows)
	}
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, r *http.Request) {
		onePage(w, r, []map[string]any{{
			"full_name": "alrayyes/a", "name": "a", "owner": map[string]string{"login": "alrayyes"},
			"permissions": map[string]bool{"push": true},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		onePage(w, r, []map[string]any{{
			"number": 12, "title": "t", "html_url": "https://git.example/alrayyes/a/pulls/12",
			"user": map[string]string{"login": "ryankes"}, "labels": []map[string]string{}, "mergeable": true,
			"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
			"head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"sha": "abc"},
		}})
	})
	mux.HandleFunc(rerunStatusPath, func(w http.ResponseWriter, r *http.Request) {
		body, total, down := f.combined()
		if down {
			w.WriteHeader(http.StatusInternalServerError)

			return
		}
		w.Header().Set("X-Total-Count", strconv.Itoa(total))
		if f.pageSize > 0 {
			page, _ := strconv.Atoi(r.URL.Query().Get("page"))
			all, _ := body["statuses"].([]map[string]any)
			from := min((max(page, 1)-1)*f.pageSize, len(all))
			body["statuses"] = all[from:min(from+f.pageSize, len(all))]
		}
		writeJSON(t, w, body)
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues", func(w http.ResponseWriter, r *http.Request) {
		onePage(w, r, []map[string]any{})
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The server version is probed in the background, whenever it likes.
		if r.URL.Path != "/api/v1/version" {
			f.mu.Lock()
			f.requests = append(f.requests, r.URL.Path)
			f.mu.Unlock()
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)

	client := forgejo.NewClient(srv.URL, "test-token", "")
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, dashboard.DefaultMaxConcurrency)

	return dashboard.NewAggregator([]dashboard.Source{source}, opts...)
}

// failedRow is a forge and a dashboard that has read its pull request as failed.
func failedRow(t *testing.T, opts ...dashboard.AggregatorOption) (*rerunForge, *dashboard.Aggregator) {
	t.Helper()
	f := &rerunForge{}
	f.post("ci / lint", "success")
	f.post("ci / test", "failure")
	agg := f.aggregator(t, opts...)
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().PullRequests, 1)
	require.Equal(t, dashboard.CIFailure, agg.Get().PullRequests[0].CI)
	f.take()

	return f, agg
}

// A rerun on the same head sends no webhook until the run ends, so the CI poll
// is what has to notice the new pending status (#5076).
func TestPollCI_FailedPullRequestWhoseJobIsRerun_StopsReadingFailed(t *testing.T) {
	t.Parallel()
	f, agg := failedRow(t)
	f.post("ci / test", "pending")

	agg.PollCI(t.Context())

	row := agg.Get().PullRequests[0]
	assert.Equal(t, dashboard.CIPending, row.CI)
	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Waiting: 1}, row.Checks)
}

func TestPollCI_UnchangedFailedPullRequest_CostsOneStatusReadAndBacksOff(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	f, agg := failedRow(t, dashboard.WithClock(func() time.Time { return now }), dashboard.WithCIPollInterval(time.Minute))

	agg.PollCI(t.Context())
	assert.Equal(t, []string{rerunStatusPath}, f.take(), "one status read and nothing else")

	var reads int
	for range 60 {
		now = now.Add(time.Minute)
		agg.PollCI(t.Context())
		reads += len(f.take())
	}
	assert.LessOrEqual(t, reads, 15, "an hour of one-minute ticks")
	assert.GreaterOrEqual(t, reads, 12, "never more than five minutes apart")
}

func TestPollCI_FailedPullRequestNobodyIsLookingAt_IsNotRead(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	activity := dashboard.NewActivity(time.Minute, clock)
	f, agg := failedRow(t, dashboard.WithClock(clock), dashboard.WithActivity(activity))
	now = now.Add(time.Hour)

	agg.PollCI(t.Context())

	assert.Empty(t, f.take())
}

func TestPollCI_FailedStatusReadThatFails_BacksOffAndKeepsTheRow(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	f, agg := failedRow(t, dashboard.WithClock(func() time.Time { return now }), dashboard.WithCIPollInterval(time.Minute))
	f.setStatusDown(true)
	agg.PollCI(t.Context())
	assert.Len(t, f.take(), 1)
	now = now.Add(time.Minute)
	agg.PollCI(t.Context())
	f.take()
	now = now.Add(time.Minute)

	agg.PollCI(t.Context())

	assert.Empty(t, f.take(), "the third minute is inside the second wait")
	assert.Equal(t, dashboard.CIFailure, agg.Get().PullRequests[0].CI)
}

// A rerun's status can sit past the first page, so the probe reads them all.
func TestPollCI_RerunStatusOnALaterPage_IsNoticed(t *testing.T) {
	t.Parallel()
	f := &rerunForge{pageSize: 1}
	f.post("ci / lint", "success")
	f.post("ci / test", "failure")
	agg := f.aggregator(t)
	agg.Refresh(t.Context())
	require.Equal(t, dashboard.CIFailure, agg.Get().PullRequests[0].CI)
	f.post("ci / test", "pending")

	agg.PollCI(t.Context())

	assert.Equal(t, dashboard.CIPending, agg.Get().PullRequests[0].CI)
}
