package githubstatus_test

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/githubstatus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const feedWithIncident = `{
  "status": {"indicator": "minor", "description": "Minor Service Outage"},
  "components": [
    {"name": "Pull Requests", "status": "degraded_performance"},
    {"name": "Codespaces", "status": "major_outage"},
    {"name": "Git Operations", "status": "operational"}
  ],
  "incidents": [
    {"name": "Degraded performance", "components": [{"name": "Pull Requests"}]},
    {"name": "Codespaces are down", "components": [{"name": "Codespaces"}]}
  ]
}`

const feedAllClear = `{"status":{"indicator":"none"},"components":[{"name":"API Requests","status":"operational"}],"incidents":[]}`

// feed serves body and counts the requests it receives.
type feed struct {
	srv   *httptest.Server
	count atomic.Int32
	body  atomic.Value
	code  atomic.Int32
	last  atomic.Pointer[http.Request]
}

func newFeed(t *testing.T, body string) *feed {
	t.Helper()
	f := &feed{}
	f.body.Store(body)
	f.code.Store(http.StatusOK)
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.count.Add(1)
		f.last.Store(r)
		w.WriteHeader(int(f.code.Load()))
		_, _ = w.Write([]byte(f.body.Load().(string)))
	}))
	t.Cleanup(f.srv.Close)

	return f
}

type clock struct{ now time.Time }

func (c *clock) Now() time.Time { return c.now }

func newClient(f *feed, c *clock, logs *bytes.Buffer) *githubstatus.Client {
	return githubstatus.New(f.srv.URL, f.srv.Client(),
		githubstatus.WithClock(c.Now),
		githubstatus.WithLogger(slog.New(slog.NewTextHandler(logs, nil))))
}

func TestStatus_ReportsOnlyIncidentsOnComponentsTheDashboardUses(t *testing.T) {
	t.Parallel()

	f := newFeed(t, feedWithIncident)
	got := newClient(f, &clock{time.Unix(1000, 0)}, &bytes.Buffer{}).ProviderStatus(t.Context())

	// Criterion 1: the title and its component. Codespaces is not used.
	require.NotNil(t, got)
	assert.Equal(t, &dashboard.ProviderStatus{
		Indicator:  "minor",
		Components: []string{"Pull Requests"},
		Incidents:  []string{"Degraded performance"},
	}, got)
}

func TestStatus_AnOutageOfAnUnusedComponentSaysNothing(t *testing.T) {
	t.Parallel()

	f := newFeed(t, `{"status":{"indicator":"major"},
	  "components":[{"name":"Codespaces","status":"major_outage"}],
	  "incidents":[{"name":"Codespaces are down","components":[{"name":"Codespaces"}]}]}`)

	assert.Nil(t, newClient(f, &clock{time.Unix(1000, 0)}, &bytes.Buffer{}).ProviderStatus(t.Context()))
}

func TestStatus_NoneSaysNothing(t *testing.T) {
	t.Parallel()

	f := newFeed(t, feedAllClear)

	assert.Nil(t, newClient(f, &clock{time.Unix(1000, 0)}, &bytes.Buffer{}).ProviderStatus(t.Context()))
}

func TestStatus_TheRequestCarriesNothingAboutTheUser(t *testing.T) {
	t.Parallel()

	f := newFeed(t, feedAllClear)
	newClient(f, &clock{time.Unix(1000, 0)}, &bytes.Buffer{}).ProviderStatus(t.Context())

	req := f.last.Load()
	require.NotNil(t, req)
	assert.Equal(t, "/api/v2/summary.json", req.URL.Path)
	assert.Empty(t, req.URL.RawQuery)
	assert.Empty(t, req.Header.Get("Authorization"))
	assert.Empty(t, req.Header.Get("Cookie"))
}

func TestStatus_FailuresShowNothingAndLogOnce(t *testing.T) {
	t.Parallel()

	for name, prepare := range map[string]func(*feed){
		"an error status": func(f *feed) { f.code.Store(http.StatusBadGateway) },
		"garbage":         func(f *feed) { f.body.Store("<html>not json") },
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			f := newFeed(t, feedAllClear)
			prepare(f)
			clk := &clock{time.Unix(1000, 0)}
			var logs bytes.Buffer
			c := newClient(f, clk, &logs)

			assert.Nil(t, c.ProviderStatus(t.Context()))
			clk.now = clk.now.Add(2 * time.Minute)
			assert.Nil(t, c.ProviderStatus(t.Context()))

			// Two real fetches, one log line (criterion 4).
			assert.EqualValues(t, 2, f.count.Load())
			assert.Equal(t, 1, bytes.Count(logs.Bytes(), []byte("level=WARN")))
		})
	}
}

func TestStatus_ALogComesBackAfterTheFeedRecovers(t *testing.T) {
	t.Parallel()

	f := newFeed(t, feedAllClear)
	f.code.Store(http.StatusBadGateway)
	clk := &clock{time.Unix(1000, 0)}
	var logs bytes.Buffer
	c := newClient(f, clk, &logs)

	c.ProviderStatus(t.Context())
	clk.now = clk.now.Add(2 * time.Minute)
	f.code.Store(http.StatusOK)
	c.ProviderStatus(t.Context())
	clk.now = clk.now.Add(2 * time.Minute)
	f.code.Store(http.StatusBadGateway)
	c.ProviderStatus(t.Context())

	assert.Equal(t, 2, bytes.Count(logs.Bytes(), []byte("level=WARN")))
}

func TestStatus_TheAnswerIsCachedForAMinute(t *testing.T) {
	t.Parallel()

	f := newFeed(t, feedWithIncident)
	clk := &clock{time.Unix(1000, 0)}
	c := newClient(f, clk, &bytes.Buffer{})

	for range 5 {
		require.NotNil(t, c.ProviderStatus(t.Context()))
	}
	assert.EqualValues(t, 1, f.count.Load(), "criterion 5: a burst makes one request")

	clk.now = clk.now.Add(59 * time.Second)
	c.ProviderStatus(t.Context())
	assert.EqualValues(t, 1, f.count.Load(), "still fresh at 59s")

	clk.now = clk.now.Add(2 * time.Second)
	c.ProviderStatus(t.Context())
	assert.EqualValues(t, 2, f.count.Load(), "stale after a minute")
}

func TestStatus_AFailedFetchIsCachedToo(t *testing.T) {
	t.Parallel()

	f := newFeed(t, "nope")
	c := newClient(f, &clock{time.Unix(1000, 0)}, &bytes.Buffer{})

	for range 4 {
		c.ProviderStatus(context.Background())
	}

	assert.EqualValues(t, 1, f.count.Load())
}

func TestStatus_ConcurrentCallsMakeOneRequest(t *testing.T) {
	t.Parallel()

	f := newFeed(t, feedWithIncident)
	c := newClient(f, &clock{time.Unix(1000, 0)}, &bytes.Buffer{})

	done := make(chan struct{})
	for range 8 {
		go func() { c.ProviderStatus(t.Context()); done <- struct{}{} }()
	}
	for range 8 {
		<-done
	}

	assert.EqualValues(t, 1, f.count.Load())
}
