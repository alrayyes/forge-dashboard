package github_test

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// advisoryTestToken is distinctive so a log line that leaks it is easy to spot.
const advisoryTestToken = "ghp_advisorysecret0123456789" //nolint:gosec // a fake token for a test

// advisoryFetchServer serves one repo and the alerts handler, counting alert reads.
func advisoryFetchServer(t *testing.T, hits *atomic.Int32, handler http.HandlerFunc) *github.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{"viewer": map[string]any{"repositories": map[string]any{
			"pageInfo": map[string]any{"hasNextPage": false},
			"nodes":    []map[string]any{repoNodeWithOwnerName()},
		}}}})
	})
	mux.HandleFunc("/repos/alrayyes/a/dependabot/alerts", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		handler(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient(advisoryTestToken, "", srv.URL)
}

func advisoriesOf(t *testing.T, client *github.Client) *dashboard.Advisories {
	t.Helper()
	result := client.Fetch(t.Context())
	require.Len(t, result.MainBranches, 1)

	return result.MainBranches[0].Advisories
}

func TestReadAdvisories_FollowsTheCursorAcrossPages(t *testing.T) {
	t.Parallel()

	var client *github.Client
	client = advisoryClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("after") == "" {
			w.Header().Set("Link", `<`+client.BaseURLForTest()+`/repos/alrayyes/a/dependabot/alerts?state=open&after=abc>; rel="next"`)
			writeJSON(t, w, []map[string]any{alert("low"), alert("medium")})

			return
		}
		assert.Equal(t, "abc", r.URL.Query().Get("after"))
		writeJSON(t, w, []map[string]any{alert("critical")})
	})

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "https://github.com/alrayyes/a")

	require.NoError(t, err)
	assert.Equal(t, 3, got.Count)
	assert.Equal(t, dashboard.SeverityCritical, got.Highest)
}

func TestReadAdvisories_PastThePageCapIsUnknownNotATruncatedCount(t *testing.T) {
	t.Parallel()

	var client *github.Client
	client = advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Link", `<`+client.BaseURLForTest()+`/repos/alrayyes/a/dependabot/alerts?state=open&after=more>; rel="next"`)
		writeJSON(t, w, []map[string]any{alert("low")})
	})

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "https://github.com/alrayyes/a")

	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Equal(t, dashboard.ReasonTooMany, got.Reason)
	assert.Zero(t, got.Count)
}

func TestFetch_ReusesAdvisoriesUntilTheyExpire(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []map[string]any{alert("low")}) })

	advisoriesOf(t, client)
	advisoriesOf(t, client)
	assert.Equal(t, int32(1), hits.Load(), "second poll reads the cache")

	client.ExpireAdvisories()
	advisoriesOf(t, client)
	assert.Equal(t, int32(2), hits.Load(), "an expired answer is read again")
}

func TestFetch_KeepsTheLastKnownAnswerWhenARefreshFails(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	var fail atomic.Bool
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) {
		if fail.Load() {
			w.WriteHeader(http.StatusBadGateway)

			return
		}
		writeJSON(t, w, []map[string]any{alert("high")})
	})
	advisoriesOf(t, client)
	fail.Store(true)
	client.ExpireAdvisories()

	got := advisoriesOf(t, client)

	require.NotNil(t, got)
	assert.Equal(t, dashboard.AdvisoriesKnown, got.State)
	assert.Equal(t, 1, got.Count)
}

func TestFetch_ABrokenAdvisoryReadBacksOffInsteadOfRetryingEveryPoll(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) })

	first := advisoriesOf(t, client)
	advisoriesOf(t, client)

	assert.Equal(t, dashboard.AdvisoriesUnknown, first.State)
	assert.Equal(t, dashboard.ReasonFailed, first.Reason)
	assert.Equal(t, int32(1), hits.Load())
}

func TestFetch_ARateLimitedFirstReadSaysThrottled(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "4102444800")
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]any{"message": "API rate limit exceeded"})
	})

	got := advisoriesOf(t, client)

	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Equal(t, dashboard.ReasonThrottled, got.Reason)
}

func TestFetch_AFailedRefreshUpdatesTheReasonOfAnUnknownAnswer(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	var fail atomic.Bool
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) {
		if fail.Load() {
			w.WriteHeader(http.StatusBadGateway)

			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	assert.Equal(t, dashboard.ReasonSwitchedOff, advisoriesOf(t, client).Reason)
	fail.Store(true)
	client.ExpireAdvisories()

	assert.Equal(t, dashboard.ReasonFailed, advisoriesOf(t, client).Reason)
}

func TestFetch_ARateLimitedRefreshKeepsTheKnownAnswer(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	var limited atomic.Bool
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) {
		if limited.Load() {
			w.Header().Set("X-RateLimit-Limit", "5000")
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.Header().Set("X-RateLimit-Reset", "4102444800")
			w.WriteHeader(http.StatusForbidden)
			writeJSON(t, w, map[string]any{"message": "API rate limit exceeded"})

			return
		}
		writeJSON(t, w, []map[string]any{alert("high")})
	})
	advisoriesOf(t, client)
	limited.Store(true)
	client.ExpireAdvisories()

	got := advisoriesOf(t, client)

	assert.Equal(t, dashboard.AdvisoriesKnown, got.State)
}

func TestFetch_AlertsSwitchedOffAfterAKnownAnswerReplacesIt(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	var off atomic.Bool
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) {
		if off.Load() {
			w.WriteHeader(http.StatusNotFound)

			return
		}
		writeJSON(t, w, []map[string]any{alert("high")})
	})
	advisoriesOf(t, client)
	off.Store(true)
	client.ExpireAdvisories()

	got := advisoriesOf(t, client)

	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Equal(t, dashboard.ReasonSwitchedOff, got.Reason)
}

func TestFetch_CountsAdvisoryReadsUnderTheirOwnKind(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []map[string]any{}) })
	counters := apistats.New()
	client.SetStats(counters, "token:abcd")

	advisoriesOf(t, client)

	var advisoryReads int64
	for _, b := range counters.Snapshot() {
		if b.Kind == apistats.KindAdvisories {
			advisoryReads += b.REST + b.NotModified
		}
	}
	assert.Equal(t, int64(1), advisoryReads)
}

// logCapture is a slog handler that records every line.
type logCapture struct {
	mu    sync.Mutex
	lines []string
}

func (l *logCapture) Enabled(context.Context, slog.Level) bool { return true }
func (l *logCapture) WithAttrs([]slog.Attr) slog.Handler       { return l }
func (l *logCapture) WithGroup(string) slog.Handler            { return l }
func (l *logCapture) Handle(_ context.Context, r slog.Record) error {
	var b strings.Builder
	b.WriteString(r.Level.String() + " " + r.Message)
	r.Attrs(func(a slog.Attr) bool {
		b.WriteString(" " + a.Key + "=" + a.Value.String())

		return true
	})
	l.mu.Lock()
	l.lines = append(l.lines, b.String())
	l.mu.Unlock()

	return nil
}

// captureLogs gives the client its own logger, so no test touches slog's default.
func captureLogs(client *github.Client) *logCapture {
	c := &logCapture{}
	client.SetLogger(slog.New(c))

	return c
}

func (l *logCapture) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()

	return append([]string(nil), l.lines...)
}

func (l *logCapture) matching(sub string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for _, line := range l.lines {
		if strings.Contains(line, sub) {
			out = append(out, line)
		}
	}

	return out
}

func TestFetch_ARefusedAlertsReadLogsStatusAndMessageOncePerChange(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	status := atomic.Int32{}
	status.Store(http.StatusForbidden)
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(int(status.Load()))
		_, _ = w.Write([]byte(`{"message":"Resource not accessible by integration"}`))
	})
	logs := captureLogs(client)

	advisoriesOf(t, client)
	client.ExpireAdvisories()
	advisoriesOf(t, client)

	got := logs.matching("dependency advisories refused")
	require.Len(t, got, 1, "the same refusal is logged once")
	assert.Contains(t, got[0], "status=403")
	assert.Contains(t, got[0], "Resource not accessible by integration")
	assert.Contains(t, got[0], "repo=alrayyes/a")

	status.Store(http.StatusNotFound)
	client.ExpireAdvisories()
	advisoriesOf(t, client)

	got = logs.matching("dependency advisories refused")
	require.Len(t, got, 2, "a changed answer is logged again")
	assert.Contains(t, got[1], "status=404")

	for _, line := range logs.all() {
		assert.NotContains(t, line, advisoryTestToken, "the token never reaches a log line")
	}
}

func TestFetch_ARefusalSurvivesAFailedReadBetweenTwoIdenticalOnes(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	status := atomic.Int32{}
	status.Store(http.StatusForbidden)
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(int(status.Load()))
		_, _ = w.Write([]byte(`{"message":"Resource not accessible by integration"}`))
	})
	logs := captureLogs(client)

	advisoriesOf(t, client)
	status.Store(http.StatusBadGateway)
	client.ExpireAdvisories()
	advisoriesOf(t, client)
	status.Store(http.StatusForbidden)
	client.ExpireAdvisories()
	advisoriesOf(t, client)

	assert.Len(t, logs.matching("dependency advisories refused"), 1, "403, 5xx, the same 403 says it once")
	assert.Len(t, logs.matching("dependency advisories read failed"), 1)
}

func TestFetch_RetryDelayTellsARefusalFromAFailureAndBacksOffOnARepeat(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	status := atomic.Int32{}
	status.Store(http.StatusForbidden)
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(int(status.Load()))
		_, _ = w.Write([]byte(`{"message":"Resource not accessible by integration"}`))
	})
	left := func() time.Duration { return client.AdvisoryTTLForTest("alrayyes/a").Round(time.Second) }

	advisoriesOf(t, client)
	assert.Equal(t, github.AdvisoriesRetry, left(), "a first refusal is asked again soon")

	client.ExpireAdvisories()
	advisoriesOf(t, client)
	assert.Equal(t, github.AdvisoriesTTL, left(), "the same refusal twice settles at the normal interval")

	status.Store(http.StatusBadGateway)
	client.ExpireAdvisories()
	advisoriesOf(t, client)
	assert.Equal(t, github.AdvisoriesRetry, left(), "a failed read is retried soon")

	status.Store(http.StatusNotFound)
	client.ExpireAdvisories()
	advisoriesOf(t, client)
	assert.Equal(t, github.AdvisoriesRetry, left(), "a changed refusal starts over")
}
