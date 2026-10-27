package api_test

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
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
	checks   []dashboard.Check
	checkErr error
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
	s.lists.Add(1)

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

	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/dashboard/stream?sid="+watchedStreamID, nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	require.Equal(t, http.StatusOK, resp.StatusCode)

	events := make(chan sseEvent, 16)
	go readNamedEvents(bufio.NewReader(resp.Body), events)

	return &checkFeed{srvURL: srvURL, cookie: sessionCookie, events: events}, webhookToken + ":" + webhookSecret
}

// watch posts a watch and answers the status code.
func (f *checkFeed) watch(t *testing.T, body string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.srvURL+"/api/dashboard/stream/watch", strings.NewReader(body))
	require.NoError(t, err)
	req.AddCookie(f.cookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())

	return resp.StatusCode
}

func (f *checkFeed) nextChecks(t *testing.T) map[string]any {
	t.Helper()
	for {
		select {
		case ev, ok := <-f.events:
			require.True(t, ok, "stream closed before a checks event arrived")
			if ev.name != "checks" {
				continue
			}
			var got map[string]any
			require.NoError(t, json.Unmarshal([]byte(ev.data), &got))

			return got
		case <-time.After(pollBudget):
			t.Fatal("no checks event arrived")
		}
	}
}

const watchPR = `{"streamId":"` + watchedStreamID + `","subjects":[{"kind":"pull_request","forge":"github","fullName":"alrayyes/tempus-fugit","number":7}]}`

func TestCheckStream_WatchingAPullRequestSendsItsChecks(t *testing.T) {
	t.Parallel()

	source := &checkFeedSource{checks: []dashboard.Check{{Name: "build", State: dashboard.CheckSuccess}}}
	feed, _ := openCheckFeed(t, source)

	require.Equal(t, http.StatusNoContent, feed.watch(t, watchPR))

	got := feed.nextChecks(t)
	assert.Equal(t, "pull_request", got["kind"])
	assert.Equal(t, "github", got["forge"])
	assert.Equal(t, "alrayyes/tempus-fugit", got["fullName"])
	assert.InDelta(t, 7, got["number"], 0)
	checks, ok := got["checks"].([]any)
	require.True(t, ok)
	require.Len(t, checks, 1)
	assert.Equal(t, "build", checks[0].(map[string]any)["name"])
}

func TestCheckStream_EachCheckCarriesStatusAndConclusionNotState(t *testing.T) {
	t.Parallel()

	source := &checkFeedSource{checks: []dashboard.Check{{Name: "build", State: dashboard.CheckTimedOut}}}
	feed, _ := openCheckFeed(t, source)
	feed.watch(t, watchPR)

	check := feed.nextChecks(t)["checks"].([]any)[0].(map[string]any)

	assert.Equal(t, map[string]any{"name": "build", "status": "completed", "conclusion": "timed_out", "url": ""}, check)
}

func TestCheckStream_AFailedListSendsTheErrorInsteadOfChecks(t *testing.T) {
	t.Parallel()

	source := &checkFeedSource{checkErr: assert.AnError}
	feed, _ := openCheckFeed(t, source)

	feed.watch(t, watchPR)

	got := feed.nextChecks(t)
	assert.NotEmpty(t, got["error"])
	assert.Nil(t, got["checks"])
}

func TestCheckStream_RefreshSendsTheChecksAgain(t *testing.T) {
	t.Parallel()

	source := &checkFeedSource{checks: []dashboard.Check{}}
	feed, _ := openCheckFeed(t, source)
	feed.watch(t, watchPR)
	feed.nextChecks(t)

	feed.watch(t, strings.Replace(watchPR, `"subjects"`, `"refresh":true,"subjects"`, 1))
	feed.nextChecks(t)

	assert.EqualValues(t, 2, source.lists.Load())
}

func TestCheckStream_ASnapshotWhereTheWatchedRowChangedSendsTheChecksAgain(t *testing.T) {
	t.Parallel()

	source := &checkFeedSource{checks: []dashboard.Check{}}
	source.ci.Store(dashboard.CIPending)
	feed, hook := openCheckFeed(t, source)
	feed.watch(t, watchPR)
	feed.nextChecks(t)

	source.ci.Store(dashboard.CISuccess)
	tokenSecret := strings.SplitN(hook, ":", 2)
	triggerWebhook(t, feed.srvURL, tokenSecret[0], tokenSecret[1])
	feed.nextChecks(t)

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
	resp, err := testClient(t).Post(srv.URL+"/api/dashboard/stream/watch", "application/json", strings.NewReader(watchPR))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
