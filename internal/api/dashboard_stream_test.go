package api_test

import (
	"bufio"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDashboardStream_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/dashboard/stream")
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
	resp, err := http.DefaultClient.Do(req)
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
	streamResp, err := http.DefaultClient.Do(streamReq)
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
	webhookResp, err := http.DefaultClient.Do(webhookReq)
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
	case <-time.After(2 * time.Second):
		t.Fatal("no SSE event received after the webhook-triggered refresh")
	}
}

func TestDashboardStream_ClosesWhenTheClientDisconnects(t *testing.T) {
	t.Parallel()

	srvURL, _, sessionCookie := newTestServerWithCountingSource(t)

	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/dashboard/stream", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	// The real assertion here is that closing the body doesn't hang or
	// panic the handler's goroutine — there's nothing further to observe
	// black-box, since the handler's own cleanup happens server-side.
	assert.NoError(t, resp.Body.Close())
}
