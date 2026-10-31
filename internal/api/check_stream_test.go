package api_test

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const watchedStreamID = "0b1f4c6e-5d2a-4e7b-9c3d-2a6f8e1b7c40"

// checkFeedSource is a GitHub source whose one pull request can change CI
// between refreshes, and which counts the job lists it was asked for.
type checkFeedSource struct {
	ci       atomic.Value // dashboard.CIStatus
	lists    atomic.Int64
	checkErr error

	mu     sync.Mutex
	checks []dashboard.Check
	// byCall, when set, answers each job list from the number of the ask.
	byCall func(call int64) []dashboard.Check
}

func (s *checkFeedSource) setChecks(checks []dashboard.Check) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.checks = checks
}

func (s *checkFeedSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (s *checkFeedSource) Fetch(_ context.Context) dashboard.Result {
	ci, _ := s.ci.Load().(dashboard.CIStatus)

	return dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/tempus-fugit", Number: 7, CI: ci},
		},
	}
}

func (s *checkFeedSource) ListChecks(_ context.Context, _, _ string, _ int) ([]dashboard.Check, error) {
	call := s.lists.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.byCall != nil {
		return s.byCall(call), s.checkErr
	}

	return s.checks, s.checkErr
}

type sseEvent struct {
	name string
	data string
}

// readNamedEvents sends every blank-line-delimited block on r as one sseEvent,
// closing out when r errs. Like streamSSEEvents it never touches *testing.T.
func readNamedEvents(r *bufio.Reader, out chan<- sseEvent) {
	defer close(out)
	var ev sseEvent
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if ev.data != "" {
				out <- ev
			}
			ev = sseEvent{}

			continue
		}
		if after, ok := strings.CutPrefix(line, "event: "); ok {
			ev.name = after
		}
		if after, ok := strings.CutPrefix(line, "data: "); ok {
			ev.data += after
		}
	}
}

type checkFeed struct {
	srvURL string
	cookie *http.Cookie
	events chan sseEvent
}

func openCheckFeed(t *testing.T, source *checkFeedSource) (*checkFeed, string) {
	t.Helper()
	srvURL, sessionCookie := newTestServerWithSource(t, source)
	webhookToken, webhookSecret := webhookCredentials(t, srvURL, sessionCookie)

	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/v1/dashboard/stream?sid="+watchedStreamID, nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	require.Equal(t, http.StatusOK, resp.StatusCode)

	events := make(chan sseEvent, 16)
	go readNamedEvents(bufio.NewReader(resp.Body), events)

	// A watch reads the row it lists for from the snapshot as it stands. Before
	// the first refresh finishes there is none, and the snapshot that brings it
	// lists the subject once more, which a test counting lists would see as an
	// extra one (#3127). A read of the dashboard holds until that refresh is in.
	load, err := http.NewRequest(http.MethodGet, srvURL+"/api/v1/dashboard", nil)
	require.NoError(t, err)
	load.AddCookie(sessionCookie)
	loaded, err := testClient(t).Do(load)
	require.NoError(t, err)
	require.NoError(t, loaded.Body.Close())
	require.Equal(t, http.StatusOK, loaded.StatusCode)

	return &checkFeed{srvURL: srvURL, cookie: sessionCookie, events: events}, webhookToken + ":" + webhookSecret
}

// watch posts a watch and answers the status code.
func (f *checkFeed) watch(t *testing.T, body string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.srvURL+"/api/v1/dashboard/stream/watch", strings.NewReader(body))
	require.NoError(t, err)
	req.AddCookie(f.cookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())

	return resp.StatusCode
}

// nextRun answers the next "run" event on the stream.
func (f *checkFeed) nextRun(t *testing.T) map[string]any {
	t.Helper()
	for {
		select {
		case ev, ok := <-f.events:
			require.True(t, ok, "stream closed before a run event arrived")
			if ev.name != "run" {
				continue
			}
			var got map[string]any
			require.NoError(t, json.Unmarshal([]byte(ev.data), &got))

			return got
		case <-time.After(pollBudget):
			t.Fatal("no run event arrived")
		}
	}
}

// nextListing reads run events up to the one that ends a listing, which is
// the one marked final or the one carrying an error.
func (f *checkFeed) nextListing(t *testing.T) []map[string]any {
	t.Helper()
	var got []map[string]any
	for {
		ev := f.nextRun(t)
		got = append(got, ev)
		if ev["final"] == true || ev["error"] != nil {
			return got
		}
	}
}

const watchPR = `{"streamId":"` + watchedStreamID + `","subjects":[{"kind":"pull_request","forge":"github","fullName":"alrayyes/tempus-fugit","number":7}]}`

func TestCheckStream_WatchingAPullRequestSendsOneEventPerRun(t *testing.T) {
	t.Parallel()

	source := &checkFeedSource{checks: []dashboard.Check{
		{Name: "build", State: dashboard.CheckSuccess, RunID: 11, RunAttempt: 1},
		{Name: "lint", State: dashboard.CheckSuccess, RunID: 11, RunAttempt: 1},
		{Name: "e2e", State: dashboard.CheckRunning, RunID: 12, RunAttempt: 1},
		{Name: "codecov", State: dashboard.CheckSuccess, URL: "https://codecov.io/x"},
	}}
	feed, _ := openCheckFeed(t, source)

	require.Equal(t, http.StatusNoContent, feed.watch(t, watchPR))

	got := feed.nextListing(t)
	require.Len(t, got, 3)
	assert.Equal(t, "pull_request", got[0]["kind"])
	assert.Equal(t, "github", got[0]["forge"])
	assert.Equal(t, "alrayyes/tempus-fugit", got[0]["fullName"])
	assert.InDelta(t, 7, got[0]["number"], 0)
	assert.Equal(t, "run/11/1", got[0]["key"])
	assert.InDelta(t, 11, got[0]["runId"], 0)
	assert.InDelta(t, 1, got[0]["runAttempt"], 0)
	assert.Len(t, got[0]["checks"], 2)
	assert.Equal(t, "run/12/1", got[1]["key"])
	assert.Len(t, got[1]["checks"], 1)
	assert.Equal(t, "job/https://codecov.io/x|codecov", got[2]["key"])
	assert.Nil(t, got[2]["runId"])
	assert.Len(t, got[2]["checks"], 1)
	assert.Nil(t, got[0]["final"])
	assert.Nil(t, got[1]["final"])
	assert.Equal(t, true, got[2]["final"])
}

func TestCheckStream_ARunEventCarriesTheRunsOwnFacts(t *testing.T) {
	t.Parallel()

	started := time.Date(2026, 10, 27, 9, 0, 0, 0, time.UTC)
	finished := started.Add(3 * time.Minute)
	run := &dashboard.RunFacts{
		Status: dashboard.CheckStatusCompleted, Conclusion: "failure", StartedAt: &started, CompletedAt: &finished,
	}
	source := &checkFeedSource{checks: []dashboard.Check{
		{Name: "build", State: dashboard.CheckSuccess, RunID: 11, RunAttempt: 2, Run: run},
		{Name: "lint", State: dashboard.CheckFailure, RunID: 11, RunAttempt: 2, Run: run},
		{Name: "codecov", State: dashboard.CheckSuccess, URL: "https://codecov.io/x"},
	}}
	feed, _ := openCheckFeed(t, source)
	feed.watch(t, watchPR)

	got := feed.nextListing(t)

	require.Len(t, got, 2)
	assert.Equal(t, "completed", got[0]["status"])
	assert.Equal(t, "failure", got[0]["conclusion"])
	assert.Equal(t, started.Format(time.RFC3339), got[0]["startedAt"])
	assert.Equal(t, finished.Format(time.RFC3339), got[0]["completedAt"])
	assert.NotContains(t, got[1], "status")
	assert.NotContains(t, got[1], "conclusion")
	assert.NotContains(t, got[1], "startedAt")
	assert.NotContains(t, got[1], "completedAt")
}

func TestCheckStream_ARunWithoutFactsSendsNone(t *testing.T) {
	t.Parallel()

	source := &checkFeedSource{checks: []dashboard.Check{{Name: "build", State: dashboard.CheckRunning, RunID: 11}}}
	feed, _ := openCheckFeed(t, source)
	feed.watch(t, watchPR)

	got := feed.nextRun(t)

	assert.Equal(t, "run/11/0", got["key"])
	assert.NotContains(t, got, "status")
}

func TestCheckStream_ASubjectWithoutChecksSendsOneEmptyEvent(t *testing.T) {
	t.Parallel()

	feed, _ := openCheckFeed(t, &checkFeedSource{})

	feed.watch(t, watchPR)

	got := feed.nextListing(t)
	require.Len(t, got, 1)
	assert.Nil(t, got[0]["key"])
	assert.Empty(t, got[0]["checks"])
	assert.Equal(t, true, got[0]["final"])
}

func TestCheckStream_EachCheckCarriesStatusAndConclusionNotState(t *testing.T) {
	t.Parallel()

	source := &checkFeedSource{checks: []dashboard.Check{{Name: "build", State: dashboard.CheckTimedOut}}}
	feed, _ := openCheckFeed(t, source)
	feed.watch(t, watchPR)

	check := feed.nextRun(t)["checks"].([]any)[0].(map[string]any)

	assert.Equal(t, map[string]any{"name": "build", "status": "completed", "conclusion": "timed_out", "url": ""}, check)
}

func TestCheckStream_ARerunReplacesItsAttemptAndTheOldOneIsGone(t *testing.T) {
	t.Parallel()

	source := &checkFeedSource{checks: []dashboard.Check{
		{Name: "build", State: dashboard.CheckFailure, RunID: 11, RunAttempt: 1},
		{Name: "lint", State: dashboard.CheckSuccess, RunID: 12, RunAttempt: 1},
	}}
	feed, _ := openCheckFeed(t, source)
	feed.watch(t, watchPR)
	feed.nextListing(t)

	source.setChecks([]dashboard.Check{
		{Name: "build", State: dashboard.CheckRunning, RunID: 11, RunAttempt: 2},
		{Name: "lint", State: dashboard.CheckSuccess, RunID: 12, RunAttempt: 1},
	})
	feed.watch(t, strings.Replace(watchPR, `"subjects"`, `"refresh":true,"subjects"`, 1))
	got := feed.nextListing(t)

	require.Len(t, got, 3)
	assert.Equal(t, "run/11/2", got[0]["key"])
	assert.InDelta(t, 2, got[0]["runAttempt"], 0)
	assert.Equal(t, "run/12/1", got[1]["key"])
	assert.Equal(t, "run/11/1", got[2]["key"])
	assert.Equal(t, true, got[2]["gone"])
	assert.Empty(t, got[2]["checks"])
	assert.Equal(t, true, got[2]["final"])
}

func TestCheckStream_AFailedListSendsTheErrorInsteadOfChecks(t *testing.T) {
	t.Parallel()

	source := &checkFeedSource{checkErr: assert.AnError}
	feed, _ := openCheckFeed(t, source)

	feed.watch(t, watchPR)

	got := feed.nextRun(t)
	assert.NotEmpty(t, got["error"])
	assert.Nil(t, got["checks"])
}

func TestCheckStream_RefreshSendsTheChecksAgain(t *testing.T) {
	t.Parallel()

	source := &checkFeedSource{checks: []dashboard.Check{}}
	feed, _ := openCheckFeed(t, source)
	feed.watch(t, watchPR)
	feed.nextListing(t)

	feed.watch(t, strings.Replace(watchPR, `"subjects"`, `"refresh":true,"subjects"`, 1))
	feed.nextListing(t)

	assert.EqualValues(t, 2, source.lists.Load())
}

// Listings of one subject that overlap must still reach the page one after
// another, or a run an older listing held can land after the newer listing
// retired it. Each ask answers the same runs on its own attempt, so a page
// that applies the events holds exactly one attempt of each whenever a listing
// ends.
func TestCheckStream_OverlappingListingsOfOneSubjectNeverInterleave(t *testing.T) {
	t.Parallel()

	const (
		asks       = 4
		runsPerAsk = 30
	)
	// Nobody reads the stream until every ask is made, and the payloads are big
	// enough to fill the connection, so listings are stuck mid-send together.
	bulk := strings.Repeat("x", 128<<10)
	source := &checkFeedSource{byCall: func(call int64) []dashboard.Check {
		checks := make([]dashboard.Check, 0, runsPerAsk)
		for run := range int64(runsPerAsk) {
			checks = append(checks, dashboard.Check{Name: "build", RunID: 100 + run, RunAttempt: call, URL: bulk})
		}

		return checks
	}}
	feed, _ := openCheckFeed(t, source)
	refresh := strings.Replace(watchPR, `"subjects"`, `"refresh":true,"subjects"`, 1)
	for range asks {
		feed.watch(t, refresh)
	}

	held := map[string]bool{}
	for {
		var ev map[string]any
		select {
		case raw, ok := <-feed.events:
			if !ok {
				return
			}
			require.NoError(t, json.Unmarshal([]byte(raw.data), &ev))
		case <-time.After(time.Second):
			return
		}
		key, _ := ev["key"].(string)
		if ev["gone"] == true {
			delete(held, key)
		} else {
			held[key] = true
		}
		if ev["final"] == true {
			require.Len(t, held, runsPerAsk, "a listing ended holding runs of another listing")
		}
	}
}

func TestCheckStream_ASnapshotWhereTheWatchedRowChangedSendsTheChecksAgain(t *testing.T) {
	t.Parallel()

	source := &checkFeedSource{checks: []dashboard.Check{}}
	source.ci.Store(dashboard.CIPending)
	feed, hook := openCheckFeed(t, source)
	feed.watch(t, watchPR)
	feed.nextListing(t)

	source.ci.Store(dashboard.CISuccess)
	tokenSecret := strings.SplitN(hook, ":", 2)
	triggerWebhook(t, feed.srvURL, tokenSecret[0], tokenSecret[1])
	feed.nextListing(t)

	assert.EqualValues(t, 2, source.lists.Load())
}

func TestCheckStream_UnknownStreamIs404(t *testing.T) {
	t.Parallel()

	feed, _ := openCheckFeed(t, &checkFeedSource{})

	status := feed.watch(t, strings.Replace(watchPR, watchedStreamID, "ffffffff-5d2a-4e7b-9c3d-2a6f8e1b7c40", 1))

	assert.Equal(t, http.StatusNotFound, status)
}

func TestCheckStream_RefusesMoreSubjectsThanTheCap(t *testing.T) {
	t.Parallel()

	feed, _ := openCheckFeed(t, &checkFeedSource{})
	subject := `{"kind":"main_branch","forge":"github","fullName":"a/b"}`
	many := strings.TrimSuffix(strings.Repeat(subject+",", 9), ",")

	status := feed.watch(t, `{"streamId":"`+watchedStreamID+`","subjects":[`+many+`]}`)

	assert.Equal(t, http.StatusBadRequest, status)
}

func TestCheckStream_RefusesASubjectItCannotRead(t *testing.T) {
	t.Parallel()

	feed, _ := openCheckFeed(t, &checkFeedSource{})

	for name, subject := range map[string]string{
		"unknown kind":         `{"kind":"issue","forge":"github","fullName":"a/b"}`,
		"no owner and repo":    `{"kind":"main_branch","forge":"github","fullName":"ab"}`,
		"pull request, no num": `{"kind":"pull_request","forge":"github","fullName":"a/b"}`,
	} {
		status := feed.watch(t, `{"streamId":"`+watchedStreamID+`","subjects":[`+subject+`]}`)
		assert.Equal(t, http.StatusBadRequest, status, name)
	}
}

func triggerWebhook(t *testing.T, srvURL, token, secret string) {
	t.Helper()
	body := []byte(`{"action":"opened"}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+token, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, secret))
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)
}

func TestCheckStream_WatchRequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := testClient(t).Post(srv.URL+"/api/v1/dashboard/stream/watch", "application/json", strings.NewReader(watchPR))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
