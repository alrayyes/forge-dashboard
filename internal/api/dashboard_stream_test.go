package api_test

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDashboardStream_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := testClient(t).Get(srv.URL + "/api/dashboard/stream")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestDashboardStream_NoBackgroundRefreshYet_Returns404(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard/stream", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

// streamSSEEvents reads r until it errs (the response body closing, most
// often) and sends the concatenated "data:" lines of each event — one per
// blank-line-delimited block — to out, closing out when done. Runs in its
// own goroutine, so it deliberately never touches *testing.T: require's
// t.FailNow() only works correctly from the test's own goroutine.
func streamSSEEvents(r *bufio.Reader, out chan<- string) {
	defer close(out)
	var data strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			select {
			case out <- data.String():
			default:
			}
			data.Reset()

			continue
		}
		if after, ok := strings.CutPrefix(line, "data: "); ok {
			data.WriteString(after)
		}
	}
}

func TestDashboardStream_PushesASnapshotWhenAWebhookTriggersARefresh(t *testing.T) {
	t.Parallel()

	srvURL, _, sessionCookie := newTestServerWithCountingSource(t)
	webhookToken, webhookSecret := webhookCredentials(t, srvURL, sessionCookie)

	streamReq, err := http.NewRequest(http.MethodGet, srvURL+"/api/dashboard/stream", nil)
	require.NoError(t, err)
	streamReq.AddCookie(sessionCookie)
	streamResp, err := testClient(t).Do(streamReq)
	require.NoError(t, err)
	defer func() { _ = streamResp.Body.Close() }()
	require.Equal(t, http.StatusOK, streamResp.StatusCode)
	assert.Equal(t, "text/event-stream", streamResp.Header.Get("Content-Type"))

	events := make(chan string, 4)
	go streamSSEEvents(bufio.NewReader(streamResp.Body), events)

	body := []byte(`{"action":"opened"}`)
	webhookReq, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+webhookToken, strings.NewReader(string(body)))
	require.NoError(t, err)
	webhookReq.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, webhookSecret))
	webhookResp, err := testClient(t).Do(webhookReq)
	require.NoError(t, err)
	defer func() { _ = webhookResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, webhookResp.StatusCode)

	select {
	case data, ok := <-events:
		if !ok {
			t.Fatal("SSE stream closed before any event arrived")
		}
		var snap dashboard.Snapshot
		require.NoError(t, json.Unmarshal([]byte(data), &snap))
		require.Len(t, snap.Forges, 1)
		assert.Equal(t, dashboard.ForgeGitHub, snap.Forges[0].Forge)
	case <-time.After(pollBudget):
		t.Fatal("no SSE event received after the webhook-triggered refresh")
	}
}

func TestDashboardStream_ClosesWhenTheClientDisconnects(t *testing.T) {
	t.Parallel()

	srvURL, _, sessionCookie := newTestServerWithCountingSource(t)

	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/dashboard/stream", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	// The real assertion here is that closing the body doesn't hang or
	// panic the handler's goroutine — there's nothing further to observe
	// black-box, since the handler's own cleanup happens server-side.
	assert.NoError(t, resp.Body.Close())
}

// Shutdown waits for in-flight requests, and an open stream never ends on its
// own, so stopping the streams has to end it for real, with a stream that was
// already open and with one that opens afterwards.
func TestDashboardStream_EndsWhenTheDrainStopsStreams(t *testing.T) {
	t.Parallel()

	drain := &api.Drain{}
	srvURL, sessionCookie, _ := newTestServerWithDrain(t, &countingSource{calls: &atomic.Int64{}}, func(_ time.Duration, f func()) func() bool { return time.AfterFunc(time.Millisecond, f).Stop }, drain)
	// open starts a stream and returns a channel that yields once it ends.
	open := func() <-chan error {
		req, err := http.NewRequest(http.MethodGet, srvURL+"/api/dashboard/stream", nil)
		require.NoError(t, err)
		req.AddCookie(sessionCookie)
		resp, err := testClient(t).Do(req) //nolint:bodyclose // closed by the goroutine below
		require.NoError(t, err)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		done := make(chan error, 1)
		go func() {
			defer func() { _ = resp.Body.Close() }()
			_, err := io.Copy(io.Discard, resp.Body)
			done <- err
		}()

		return done
	}

	before := open()
	select {
	case err := <-before:
		t.Fatalf("stream ended before the drain stopped it: %v", err)
	case <-time.After(200 * time.Millisecond):
	}

	drain.StopStreams()

	select {
	case err := <-before:
		require.NoError(t, err)
	case <-time.After(pollBudget):
		t.Fatal("an open stream outlived StopStreams")
	}
	select {
	case err := <-open():
		require.NoError(t, err)
	case <-time.After(pollBudget):
		t.Fatal("a stream opened after StopStreams was not ended at once")
	}
}
