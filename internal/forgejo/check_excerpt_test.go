package forgejo_test

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// excerptServer serves one run on commit cafef00d whose jobs are given, and the
// log of each job from logs (a missing id answers 404). logCalls counts reads.
func excerptServer(t *testing.T, jobs []map[string]any, logs map[int]string, logCalls *atomic.Int32) *forgejo.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": len(jobs), "jobs": jobs})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/", func(w http.ResponseWriter, r *http.Request) {
		logCalls.Add(1)
		var id int
		_, _ = fmt.Sscanf(strings.TrimPrefix(r.URL.Path, "/api/v1/repos/alrayyes/a/actions/jobs/"), "%d/logs", &id)
		text, ok := logs[id]
		if !ok {
			w.WriteHeader(http.StatusNotFound)

			return
		}
		_, _ = io.WriteString(w, text)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func TestListChecks_FailedJob_CarriesTheEndOfItsLog(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	var log strings.Builder
	for i := 1; i <= 30; i++ {
		fmt.Fprintf(&log, "\x1b[31mline %d\x1b[0m\n", i)
	}
	client := excerptServer(t, []map[string]any{
		{"id": 7, "name": "build", "status": "failure"},
		{"id": 8, "name": "lint", "status": "success"},
	}, map[int]string{7: log.String()}, &calls)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 2)
	lines := strings.Split(checks[0].Excerpt, "\n")
	assert.Len(t, lines, 20)
	assert.Equal(t, "line 11", lines[0])
	assert.Equal(t, "line 30", lines[19])
	assert.Empty(t, checks[1].Excerpt)
	assert.Equal(t, int32(1), calls.Load(), "only the failed job's log is read")
}

func TestListChecks_FailedJobWithUnreadableLog_HasNoExcerpt(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	client := excerptServer(t, []map[string]any{{"id": 7, "name": "build", "status": "failure"}}, nil, &calls)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.Equal(t, dashboard.CheckFailure, checks[0].State)
	assert.Empty(t, checks[0].Excerpt)
}

func TestListChecks_ManyFailedJobs_GivesTheNewestJobsTheBudget(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	jobs := make([]map[string]any, 0, 8)
	logs := map[int]string{}
	for id := 1; id <= 8; id++ {
		jobs = append(jobs, map[string]any{"id": id, "name": fmt.Sprintf("job %d", id), "status": "failure"})
		logs[id] = "boom\n"
	}
	client := excerptServer(t, jobs, logs, &calls)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, int32(5), calls.Load())
	assert.Empty(t, checks[0].Excerpt, "the oldest jobs miss out, not the newest")
	assert.Empty(t, checks[2].Excerpt)
	assert.Equal(t, "boom", checks[3].Excerpt)
	assert.Equal(t, "boom", checks[7].Excerpt)
}

func TestListChecks_AFinishedJobsExcerptIsReadOnce(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	client := excerptServer(t, []map[string]any{{"id": 7, "name": "build", "status": "failure", "completed_at": "2026-10-10T09:05:00Z"}},
		map[int]string{7: "boom\n"}, &calls)

	first, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	second, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)

	assert.Equal(t, "boom", first[0].Excerpt)
	assert.Equal(t, "boom", second[0].Excerpt)
	assert.Equal(t, int32(1), calls.Load())
}

func TestListChecks_ASlowLogDoesNotStallTheList(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"jobs": []map[string]any{{"id": 7, "name": "build", "status": "failure"}}})
	})
	release := make(chan struct{})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/7/logs", func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(func() { close(release); srv.Close() })
	client := forgejo.NewClient(srv.URL, "test-token", "")
	forgejo.SetExcerptReadTimeoutForTest(client, 100*time.Millisecond)

	start := time.Now()
	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Less(t, time.Since(start), 5*time.Second)
	assert.Empty(t, checks[0].Excerpt)
}

func TestListDefaultBranchChecks_FailedJobCarriesItsExcerpt(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"name": "a", "default_branch": "main"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{
			actionRun(8, "main", "cafef00d", "failure", "2026-10-10T09:00:00Z", "2026-10-10T09:05:00Z"),
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/8/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"jobs": []map[string]any{{"id": 3, "name": "test", "status": "failure"}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/3/logs", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "FAIL internal/api\n")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := forgejo.NewClient(srv.URL, "test-token", "")

	checks, err := client.ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.Equal(t, "FAIL internal/api", checks[0].Excerpt)
}

func TestListChecks_AMissingLogDoesNotStopTheOtherReads(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"jobs": []map[string]any{
			{"id": 1, "name": "old", "status": "failure"},
			{"id": 2, "name": "mid", "status": "failure"},
			{"id": 3, "name": "new", "status": "failure"},
		}})
	})
	notFound := make(chan struct{})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/3/logs", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		close(notFound)
	})
	// The siblings answer only after the 404 has gone out and had time to be
	// acted on, so a cancel on 404 would reach them first.
	sibling := func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-notFound:
		case <-r.Context().Done():
			return
		}
		select {
		case <-time.After(300 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, "boom\n")
	}
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/1/logs", sibling)
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/2/logs", sibling)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := forgejo.NewClient(srv.URL, "test-token", "")

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, "boom", checks[0].Excerpt)
	assert.Equal(t, "boom", checks[1].Excerpt)
	assert.Empty(t, checks[2].Excerpt)
}

func TestListChecks_ARefusedLogStopsTheOtherReads(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"jobs": []map[string]any{
			{"id": 1, "name": "old", "status": "failure"},
			{"id": 2, "name": "new", "status": "failure"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/2/logs", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/1/logs", func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done() // answers only when the read is cancelled
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := forgejo.NewClient(srv.URL, "test-token", "")

	start := time.Now()
	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Less(t, time.Since(start), 5*time.Second, "the 403 cancels the slow read")
	assert.Empty(t, checks[0].Excerpt)
	assert.Empty(t, checks[1].Excerpt)
}

func TestListChecks_AJobWithNoFinishTimeIsNeverCached(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	logs := map[int]string{7: "first\n"}
	client := excerptServer(t, []map[string]any{{"id": 7, "name": "build", "status": "failure"}}, logs, &calls)

	first, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	logs[7] = "second\n"
	second, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)

	assert.Equal(t, "first", first[0].Excerpt)
	assert.Equal(t, "second", second[0].Excerpt)
}

func TestListChecks_AFailedReadIsNotCached(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	logs := map[int]string{}
	client := excerptServer(t, []map[string]any{{"id": 7, "name": "build", "status": "failure"}}, logs, &calls)

	first, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	logs[7] = "boom\n"
	second, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)

	assert.Empty(t, first[0].Excerpt)
	assert.Equal(t, "boom", second[0].Excerpt)
}

func finishedFailures(n int) []map[string]any {
	jobs := make([]map[string]any, 0, n)
	for id := 1; id <= n; id++ {
		jobs = append(jobs, map[string]any{"id": id, "name": fmt.Sprintf("job %d", id), "status": "failure", "completed_at": "2026-10-10T09:05:00Z"})
	}

	return jobs
}

func TestListChecks_CachedExcerptsDoNotUseUpTheReadBudget(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	logs := map[int]string{}
	for id := 3; id <= 7; id++ {
		logs[id] = "boom\n"
	}
	client := excerptServer(t, finishedFailures(7), logs, &calls)
	_, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	require.Equal(t, int32(5), calls.Load())
	logs[1], logs[2] = "older\n", "older\n"

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, int32(7), calls.Load(), "only the two uncached jobs were read")
	assert.Equal(t, "older", checks[0].Excerpt)
	assert.Equal(t, "older", checks[1].Excerpt)
	assert.Equal(t, "boom", checks[6].Excerpt)
}

func TestListChecks_AnEmptyLogIsNotCached(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	logs := map[int]string{7: ""}
	client := excerptServer(t, finishedFailures(7)[6:], logs, &calls)
	first, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	logs[7] = "boom\n"

	second, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Empty(t, first[0].Excerpt)
	assert.Equal(t, "boom", second[0].Excerpt)
}

func TestListChecks_AFailedReadIsNotRetriedAtOnce(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	client := excerptServer(t, finishedFailures(7)[6:], map[int]string{}, &calls)

	for range 3 {
		_, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
		require.NoError(t, err)
	}

	assert.Equal(t, int32(1), calls.Load(), "a log that failed to read waits out the retry delay")
}

func TestListChecks_ACutLogKeepsItsLastLineWhenTheCutLandedInALongOne(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	// One line longer than the read window, then the line that matters.
	log := strings.Repeat("x", 600*1024) + "\nFAIL: the real error\n"
	client := excerptServer(t, []map[string]any{{"id": 7, "name": "build", "status": "failure"}}, map[int]string{7: log}, &calls)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, "FAIL: the real error", checks[0].Excerpt)
}

func TestExcerptCache_AFailureIsForgottenAfterTheDelay(t *testing.T) {
	t.Parallel()

	now := time.Now()
	cache := forgejo.NewExcerptCacheForTest(func() time.Time { return now })
	cache.Fail("7@1")
	require.True(t, cache.RecentlyFailed("7@1"))

	now = now.Add(2 * time.Minute)

	assert.False(t, cache.RecentlyFailed("7@1"))
}

func TestListChecks_ASiblingsCancelIsNotRememberedAsAFailure(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"jobs": finishedFailures(2)})
	})
	refused := make(chan struct{})
	started := make(chan struct{})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/2/logs", func(w http.ResponseWriter, _ *http.Request) {
		<-started
		w.WriteHeader(http.StatusForbidden)
		close(refused)
	})
	var oldReads atomic.Int32
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/1/logs", func(w http.ResponseWriter, r *http.Request) {
		if oldReads.Add(1) == 1 {
			close(started)
		} else {
			_, _ = io.WriteString(w, "boom\n")

			return
		}
		select {
		case <-refused:
			<-r.Context().Done()
		case <-r.Context().Done():
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := forgejo.NewClient(srv.URL, "test-token", "")

	_, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	_, err = client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)

	assert.Equal(t, int32(2), oldReads.Load(), "job 1 was cancelled, never tried, so it is read again")
}

func TestListChecks_AnOlderCachedExcerptSurvivesAnExhaustedBudget(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	jobs := finishedFailures(7)
	for i := 1; i < 7; i++ {
		jobs[i]["status"] = "success"
	}
	logs := map[int]string{}
	for id := 1; id <= 7; id++ {
		logs[id] = "boom\n"
	}
	client := excerptServer(t, jobs, logs, &calls)
	_, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	for i := 1; i < 7; i++ {
		jobs[i]["status"] = "failure"
	}

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, int32(6), calls.Load(), "five new reads, job 1 kept")
	assert.Empty(t, checks[1].Excerpt, "job 2 is the sixth uncached and waits for the next list")
	assert.Equal(t, "boom", checks[0].Excerpt, "the older job was read before, so it keeps its excerpt")
}

func TestListChecks_ARateLimitStopsTheOtherReads(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"jobs": finishedFailures(3)})
	})
	limited := make(chan struct{})
	var siblingsAnswered atomic.Int32
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/3/logs", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		close(limited)
	})
	sibling := func(w http.ResponseWriter, r *http.Request) {
		<-limited
		select {
		case <-time.After(300 * time.Millisecond):
			siblingsAnswered.Add(1)
			_, _ = io.WriteString(w, "boom\n")
		case <-r.Context().Done():
		}
	}
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/1/logs", sibling)
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/2/logs", sibling)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := forgejo.NewClient(srv.URL, "test-token", "")

	_, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Zero(t, siblingsAnswered.Load(), "a limited forge is not asked again by the same list")
}
