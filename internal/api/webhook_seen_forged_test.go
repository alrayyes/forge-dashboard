package api_test

import (
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The event header is not covered by the signature, so a signed body replayed
// under a check_run header must not make a repo look like its check deliveries
// are arriving: that would silence the CI poll for it.
func TestWebhook_ACheckHeaderOverANonCheckBodyDoesNotMarkChecksSeen(t *testing.T) {
	t.Parallel()

	source := &repoCountingSource{fetchCalls: &atomic.Int64{}}
	srvURL, sessionCookie, manager, userID := newTestServerWithManager(t, source, func(_ time.Duration, f func()) func() bool {
		return time.AfterFunc(time.Millisecond, f).Stop
	})
	require.Eventually(t, func() bool { return source.fetchCalls.Load() >= 1 }, time.Second, 5*time.Millisecond)
	token, secret := webhookCredentials(t, srvURL, sessionCookie)

	body := []byte(`{"action":"created","comment":{"id":1},"repository":{"full_name":"alrayyes/forged","name":"forged","owner":{"login":"alrayyes"}}}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+token, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, secret))
	req.Header.Set("X-GitHub-Event", "check_run")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	require.Eventually(t, func() bool {
		_, ok := manager.LastDelivery(userID(), dashboard.ForgeGitHub, "alrayyes/forged", dashboard.EventClassOther)

		return ok
	}, time.Second, 5*time.Millisecond, "the delivery is still recorded, as an event of no particular class")
	_, seen := manager.LastDelivery(userID(), dashboard.ForgeGitHub, "alrayyes/forged", dashboard.EventClassCheck)
	assert.False(t, seen)
}
