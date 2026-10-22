package forgejo_test

import (
	"context"
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
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// excerptServer serves one run on commit cafef00d whose jobs are given, and the
// log of each job from logs (a missing id answers 404). logCalls counts reads.
func excerptServer(t *testing.T, jobs []map[string]any, logs map[int]string, logCalls *atomic.Int32, recorder ...requestlog.Recorder) *forgejo.Client {
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

	return forgejo.NewClient(srv.URL, "test-token", "", recorder...)
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

func TestListChecks_AJobWithNoFinishTimeIsKeptOnlyBriefly(t *testing.T) {
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
	assert.Equal(t, "first", second[0].Excerpt, "an unkeyed job is not read on every poll")
	assert.Equal(t, int32(1), calls.Load())
}

func TestListChecks_AJobThatJustFinishedIsReadAgainLater(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []map[string]any{{"id": 7, "name": "build", "status": "failure", "completed_at": now}}
	client := excerptServer(t, jobs, map[int]string{7: "partial\n"}, &calls)

	first, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	second, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)

	assert.Equal(t, "partial", first[0].Excerpt)
	assert.Equal(t, "partial", second[0].Excerpt)
	assert.Equal(t, int32(1), calls.Load(), "within the delay it is kept, so a poll costs no read")
}

func TestExcerptCache_AnExcerptOfAJobThatJustFinishedExpires(t *testing.T) {
	t.Parallel()

	at := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	cache := forgejo.NewExcerptCacheForTest(func() time.Time { return at })
	cache.Put("early", "partial", false)
	cache.Put("settled", "whole", true)

	_, early := cache.Get("early")
	assert.True(t, early)
	at = at.Add(2 * time.Minute)
	_, early = cache.Get("early")
	text, settled := cache.Get("settled")

	assert.False(t, early, "a log read before it settled is read once more")
	assert.True(t, settled)
	assert.Equal(t, "whole", text)
}

func TestAddFailureExcerpts_ACancelledListStillAttachesKeptExcerpts(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	client := excerptServer(t, finishedFailures(3), map[int]string{1: "a\n", 2: "b\n", 3: "c\n"}, &calls)
	warm := []dashboard.Check{{Name: "three", State: dashboard.CheckFailure, JobID: 3}}
	forgejo.AddFailureExcerptsForTest(t.Context(), client, "alrayyes", "a", warm, []string{"a#3@1"})
	require.Equal(t, "c", warm[0].Excerpt)
	checks := []dashboard.Check{
		{Name: "one", State: dashboard.CheckFailure, JobID: 1},
		{Name: "two", State: dashboard.CheckFailure, JobID: 2},
		{Name: "three", State: dashboard.CheckFailure, JobID: 3},
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	forgejo.AddFailureExcerptsForTest(ctx, client, "alrayyes", "a", checks, []string{"a#1@1", "a#2@1", "a#3@1"})

	assert.Equal(t, "c", checks[2].Excerpt, "a kept excerpt does not depend on the list still being live")
}

func TestListChecks_AMissingLogIsNotAFailedRequest(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	rec := &fakeRecorder{}
	client := excerptServer(t, finishedFailures(1), map[int]string{}, &calls, rec)

	_, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	var seen bool
	for _, e := range rec.all() {
		if strings.Contains(e.Endpoint, "/jobs/1/logs") {
			seen = true
			assert.Equal(t, http.StatusNotFound, e.StatusCode)
			assert.Equal(t, requestlog.OutcomeSuccess, e.Outcome, "a pruned log is expected, not an error")
		}
	}
	assert.True(t, seen, "the read is still recorded")
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

func TestListChecks_AnEmptyLogIsNotRetriedAtOnce(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	client := excerptServer(t, finishedFailures(7)[6:], map[int]string{7: ""}, &calls)

	for range 3 {
		checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
		require.NoError(t, err)
		assert.Empty(t, checks[0].Excerpt)
	}

	assert.Equal(t, int32(1), calls.Load(), "an empty log waits out the retry delay like a failed read, instead of holding a read slot every poll")
}

func TestListChecks_TheSameJobIdInTwoReposKeepsSeparateExcerpts(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	for _, repo := range []string{"a", "b"} {
		base := "/api/v1/repos/alrayyes/" + repo
		mux.HandleFunc(base+"/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
		})
		mux.HandleFunc(base+"/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42}}})
		})
		mux.HandleFunc(base+"/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, map[string]any{"jobs": finishedFailures(1)})
		})
		mux.HandleFunc(base+"/actions/jobs/1/logs", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, "boom in "+repo+"\n")
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := forgejo.NewClient(srv.URL, "test-token", "")

	first, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	second, err := client.ListChecks(t.Context(), "alrayyes", "b", 5)
	require.NoError(t, err)

	assert.Equal(t, "boom in a", first[0].Excerpt)
	assert.Equal(t, "boom in b", second[0].Excerpt)
}

func TestExcerptReadWindow_IsTheGitHubTailSize(t *testing.T) {
	t.Parallel()

	assert.Equal(t, 16<<10, forgejo.ExcerptReadWindow)
}

func TestAddFailureExcerpts_StartsNoReadOnceTheListIsCancelled(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	rec := &fakeRecorder{}
	client := excerptServer(t, finishedFailures(3), map[int]string{1: "a\n", 2: "b\n", 3: "c\n"}, &calls, rec)
	checks := []dashboard.Check{
		{Name: "one", State: dashboard.CheckFailure, JobID: 1},
		{Name: "two", State: dashboard.CheckFailure, JobID: 2},
		{Name: "three", State: dashboard.CheckFailure, JobID: 3},
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	forgejo.AddFailureExcerptsForTest(ctx, client, "alrayyes", "a", checks, []string{"a#1@1", "a#2@1", "a#3@1"})

	assert.Zero(t, calls.Load())
	assert.Empty(t, rec.all(), "a read that is already doomed is not started, so it is not recorded as a failed request")
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

func TestListChecks_ACancelledSiblingIsRememberedWithTheRefusal(t *testing.T) {
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

	assert.Equal(t, int32(1), oldReads.Load(), "the refusal is remembered for job 1 too, so the next list does not send it again")
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

func TestListChecks_AReadCancelledByASiblingIsNotRecordedAsAFailedRequest(t *testing.T) {
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
	rec := &fakeRecorder{}
	client := forgejo.NewClient(srv.URL, "test-token", "", rec)

	_, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	for _, e := range rec.all() {
		assert.NotContains(t, e.Endpoint, "/jobs/1/", "a read the list cancelled is not a failed request")
		assert.NotContains(t, e.Endpoint, "/jobs/2/", "a read the list cancelled is not a failed request")
	}
}

func TestListChecks_ARefusalIsRememberedForTheWholeBatch(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"jobs": finishedFailures(4)})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/", func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := forgejo.NewClient(srv.URL, "test-token", "")

	_, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	// A cancelled read may still reach the server a moment later.
	var first int32
	require.Eventually(t, func() bool {
		now := calls.Load()
		settled := now == first
		first = now

		return settled
	}, 5*time.Second, 50*time.Millisecond)
	_, err = client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	time.Sleep(100 * time.Millisecond)

	assert.Equal(t, first, calls.Load(), "no read of the batch is tried again within the delay")
}

func TestListChecks_ARerunWithTheSameFinishTimeIsReadAgain(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	logs := map[int]string{7: "first run\n"}
	jobs := []map[string]any{{"id": 7, "name": "build", "status": "failure", "completed_at": "2026-10-10T09:05:00Z", "run_attempt": 1}}
	client := excerptServer(t, jobs, logs, &calls)

	first, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	logs[7] = "second run\n"
	jobs[0]["run_attempt"] = 2
	second, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)

	assert.Equal(t, "first run", first[0].Excerpt)
	assert.Equal(t, "second run", second[0].Excerpt)
}

func TestExcerptCache_PastTheCapANewFailureIsStillRemembered(t *testing.T) {
	t.Parallel()

	at := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	cache := forgejo.NewExcerptCacheForTest(func() time.Time { return at })
	for i := range forgejo.MaxExcerptsForTest + 5 {
		cache.Fail(fmt.Sprintf("job-%d", i))
	}

	assert.True(t, cache.RecentlyFailed(fmt.Sprintf("job-%d", forgejo.MaxExcerptsForTest+4)))
	assert.False(t, cache.RecentlyFailed("job-0"), "the oldest goes first")
}
