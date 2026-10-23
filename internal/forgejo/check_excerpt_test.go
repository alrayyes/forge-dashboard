package forgejo_test

import (
	"errors"
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

// listThenExcerpt lists the checks of pull request 5 and reads job id's excerpt,
// the order the panel follows.
func listThenExcerpt(t *testing.T, c *forgejo.Client, repo string, id int64) (string, error) {
	t.Helper()
	_, err := c.ListChecks(t.Context(), "alrayyes", repo, 5)
	require.NoError(t, err)

	text, err := c.JobExcerpt(t.Context(), "alrayyes", repo, id)
	if err != nil {
		return "", fmt.Errorf("job excerpt: %w", err)
	}

	return text, nil
}

func TestListChecks_ReadsNoJobLog(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	client := excerptServer(t, finishedFailures(3), map[int]string{1: "boom\n", 2: "boom\n", 3: "boom\n"}, &calls)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 3)
	for _, c := range checks {
		assert.Empty(t, c.Excerpt)
	}
	assert.Zero(t, calls.Load(), "the checks list answers at the speed of the job list")
}

func TestListDefaultBranchChecks_ReadsNoJobLog(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
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
		calls.Add(1)
		_, _ = io.WriteString(w, "FAIL internal/api\n")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := forgejo.NewClient(srv.URL, "test-token", "")

	checks, err := client.ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.Empty(t, checks[0].Excerpt)
	assert.Zero(t, calls.Load())
}

func TestJobExcerpt_CarriesTheEndOfTheLog(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	var log strings.Builder
	for i := 1; i <= 30; i++ {
		fmt.Fprintf(&log, "\x1b[31mline %d\x1b[0m\n", i)
	}
	client := excerptServer(t, []map[string]any{{"id": 7, "name": "build", "status": "failure"}}, map[int]string{7: log.String()}, &calls)

	text, err := listThenExcerpt(t, client, "a", 7)

	require.NoError(t, err)
	lines := strings.Split(text, "\n")
	assert.Len(t, lines, 20)
	assert.Equal(t, "line 11", lines[0])
	assert.Equal(t, "line 30", lines[19])
	assert.Equal(t, int32(1), calls.Load())
}

func TestJobExcerpt_AMissingLogIsNoExcerptAndNotAFailedRequest(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	rec := &fakeRecorder{}
	client := excerptServer(t, finishedFailures(1), map[int]string{}, &calls, rec)

	text, err := listThenExcerpt(t, client, "a", 1)

	require.NoError(t, err)
	assert.Empty(t, text)
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

func TestJobExcerpt_AFinishedJobsExcerptIsReadOnce(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	client := excerptServer(t, finishedFailures(1), map[int]string{1: "boom\n"}, &calls)

	first, err := listThenExcerpt(t, client, "a", 1)
	require.NoError(t, err)
	second, err := listThenExcerpt(t, client, "a", 1)
	require.NoError(t, err)

	assert.Equal(t, "boom", first)
	assert.Equal(t, "boom", second)
	assert.Equal(t, int32(1), calls.Load())
}

func TestJobExcerpt_AJobWithNoFinishTimeIsKeptOnlyBriefly(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	logs := map[int]string{7: "first\n"}
	client := excerptServer(t, []map[string]any{{"id": 7, "name": "build", "status": "failure"}}, logs, &calls)

	first, err := listThenExcerpt(t, client, "a", 7)
	require.NoError(t, err)
	logs[7] = "second\n"
	second, err := listThenExcerpt(t, client, "a", 7)
	require.NoError(t, err)

	assert.Equal(t, "first", first)
	assert.Equal(t, "first", second, "an unkeyed job is not read on every look")
	assert.Equal(t, int32(1), calls.Load())
}

func TestJobExcerpt_AJobThatJustFinishedIsKeptOnlyBriefly(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []map[string]any{{"id": 7, "name": "build", "status": "failure", "completed_at": now}}
	client := excerptServer(t, jobs, map[int]string{7: "partial\n"}, &calls)

	first, err := listThenExcerpt(t, client, "a", 7)
	require.NoError(t, err)
	second, err := listThenExcerpt(t, client, "a", 7)
	require.NoError(t, err)

	assert.Equal(t, "partial", first)
	assert.Equal(t, "partial", second)
	assert.Equal(t, int32(1), calls.Load(), "within the delay it is kept, so a look costs no read")
}

func TestJobExcerpt_AnEmptyLogIsNotRetriedAtOnce(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	client := excerptServer(t, finishedFailures(1), map[int]string{1: ""}, &calls)

	for range 3 {
		text, err := listThenExcerpt(t, client, "a", 1)
		require.NoError(t, err)
		assert.Empty(t, text)
	}

	assert.Equal(t, int32(1), calls.Load())
}

func TestJobExcerpt_ASlowLogIsGivenUpOn(t *testing.T) {
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
	text, _ := listThenExcerpt(t, client, "a", 7)

	assert.Less(t, time.Since(start), 5*time.Second)
	assert.Empty(t, text)
}

func TestJobExcerpt_ARefusedReadIsReportedAndNotRepeatedAtOnce(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		status int
		kind   dashboard.ForgeErrorKind
	}{
		{http.StatusForbidden, dashboard.ForgeErrorUnauthorized},
		{http.StatusTooManyRequests, dashboard.ForgeErrorRateLimited},
	} {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
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
				writeJSON(t, w, map[string]any{"jobs": finishedFailures(1)})
			})
			mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/1/logs", func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.WriteHeader(tc.status)
			})
			srv := httptest.NewServer(mux)
			t.Cleanup(srv.Close)
			client := forgejo.NewClient(srv.URL, "test-token", "")

			_, err := listThenExcerpt(t, client, "a", 1)
			clientErr, ok := errors.AsType[*dashboard.ClientError](err)
			require.True(t, ok, "got %v", err)
			assert.Equal(t, tc.kind, clientErr.Kind)

			again, err := client.JobExcerpt(t.Context(), "alrayyes", "a", 1)
			require.NoError(t, err)
			assert.Empty(t, again)
			assert.Equal(t, int32(1), calls.Load(), "a refused log is not asked for again within the delay")
		})
	}
}

func TestJobExcerpt_AJobTheListNeverShowedIsStillRead(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	client := excerptServer(t, nil, map[int]string{9: "boom\n"}, &calls)

	text, err := client.JobExcerpt(t.Context(), "alrayyes", "a", 9)

	require.NoError(t, err)
	assert.Equal(t, "boom", text)
}

func TestJobExcerpt_TheSameJobIdInTwoReposKeepsSeparateExcerpts(t *testing.T) {
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

	first, err := listThenExcerpt(t, client, "a", 1)
	require.NoError(t, err)
	second, err := listThenExcerpt(t, client, "b", 1)
	require.NoError(t, err)

	assert.Equal(t, "boom in a", first)
	assert.Equal(t, "boom in b", second)
}

func TestJobExcerpt_ARerunWithTheSameFinishTimeIsReadAgain(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	logs := map[int]string{7: "first run\n"}
	jobs := []map[string]any{{"id": 7, "name": "build", "status": "failure", "completed_at": "2026-10-10T09:05:00Z", "run_attempt": 1}}
	client := excerptServer(t, jobs, logs, &calls)

	first, err := listThenExcerpt(t, client, "a", 7)
	require.NoError(t, err)
	logs[7] = "second run\n"
	jobs[0]["run_attempt"] = 2
	second, err := listThenExcerpt(t, client, "a", 7)
	require.NoError(t, err)

	assert.Equal(t, "first run", first)
	assert.Equal(t, "second run", second)
}

func TestJobExcerpt_ACutLogKeepsItsLastLineWhenTheCutLandedInALongOne(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	// One line longer than the read window, then the line that matters.
	log := strings.Repeat("x", 600*1024) + "\nFAIL: the real error\n"
	client := excerptServer(t, []map[string]any{{"id": 7, "name": "build", "status": "failure"}}, map[int]string{7: log}, &calls)

	text, err := listThenExcerpt(t, client, "a", 7)

	require.NoError(t, err)
	assert.Equal(t, "FAIL: the real error", text)
}

func finishedFailures(n int) []map[string]any {
	jobs := make([]map[string]any, 0, n)
	for id := 1; id <= n; id++ {
		jobs = append(jobs, map[string]any{"id": id, "name": fmt.Sprintf("job %d", id), "status": "failure", "completed_at": "2026-10-10T09:05:00Z"})
	}

	return jobs
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

func TestExcerptCache_AFailureIsForgottenAfterTheDelay(t *testing.T) {
	t.Parallel()

	now := time.Now()
	cache := forgejo.NewExcerptCacheForTest(func() time.Time { return now })
	cache.Fail("7@1")
	require.True(t, cache.RecentlyFailed("7@1"))

	now = now.Add(2 * time.Minute)

	assert.False(t, cache.RecentlyFailed("7@1"))
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

func TestExcerptReadWindow_IsTheGitHubTailSize(t *testing.T) {
	t.Parallel()

	assert.Equal(t, 16<<10, forgejo.ExcerptReadWindow)
}

func TestJobExcerpt_AFailedReadIsNotRetriedAtOnce(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	client := excerptServer(t, finishedFailures(1), map[int]string{}, &calls)

	for range 3 {
		_, err := listThenExcerpt(t, client, "a", 1)
		require.NoError(t, err)
	}

	assert.Equal(t, int32(1), calls.Load(), "a log that failed to read waits out the retry delay")
}
