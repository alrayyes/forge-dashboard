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

	return github.NewClient("test-token", "", srv.URL)
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
	assert.Equal(t, int32(1), hits.Load())
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

// logCapture swaps slog's default for a handler that records every line.
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

func captureLogs(t *testing.T) *logCapture {
	t.Helper()
	c := &logCapture{}
	previous := slog.Default()
	slog.SetDefault(slog.New(c))
	t.Cleanup(func() { slog.SetDefault(previous) })

	return c
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
	logs := captureLogs(t)
	var hits atomic.Int32
	status := atomic.Int32{}
	status.Store(http.StatusForbidden)
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(int(status.Load()))
		_, _ = w.Write([]byte(`{"message":"Resource not accessible by integration"}`))
	})

	advisoriesOf(t, client)
	client.ExpireAdvisories()
	advisoriesOf(t, client)

	got := logs.matching("dependency advisories refused")
	require.Len(t, got, 1, "the same refusal is logged once")
	assert.Contains(t, got[0], "status=403")
	assert.Contains(t, got[0], "Resource not accessible by integration")
	assert.Contains(t, got[0], "repo=alrayyes/a")
	assert.NotContains(t, got[0], "test-token")

	status.Store(http.StatusNotFound)
	client.ExpireAdvisories()
	advisoriesOf(t, client)

	got = logs.matching("dependency advisories refused")
	require.Len(t, got, 2, "a changed answer is logged again")
	assert.Contains(t, got[1], "status=404")
}

func TestFetch_ARefusedAnswerIsAskedAgainAfterTheRetryDelay(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) })

	advisoriesOf(t, client)

	assert.Equal(t, github.AdvisoriesRetry, client.AdvisoryTTLForTest("alrayyes/a").Round(time.Minute))
}
