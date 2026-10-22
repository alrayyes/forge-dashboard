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

const (
	headSHA  = "0123456789abcdef0123456789abcdef01234567"
	otherSHA = "fedcba9876543210fedcba9876543210fedcba98"
)

func TestWebhook_RecordsTheEventClassPerRepo(t *testing.T) {
	t.Parallel()

	source := &repoCountingSource{fetchCalls: &atomic.Int64{}}
	srvURL, sessionCookie, manager := newTestServerWithManager(t, source, func(_ time.Duration, f func()) func() bool {
		return time.AfterFunc(time.Millisecond, f).Stop
	})
	require.Eventually(t, func() bool { return source.fetchCalls.Load() >= 1 }, time.Second, 5*time.Millisecond)
	token, secret := webhookCredentials(t, srvURL, sessionCookie)

	send := func(repo, event string) {
		t.Helper()
		body := []byte(`{"action":"created","check_run":{"id":1,"head_sha":"` + headSHA + `"},"repository":{"full_name":"alrayyes/` + repo + `","name":"` + repo + `","owner":{"login":"alrayyes"}}}`)
		req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+token, strings.NewReader(string(body)))
		require.NoError(t, err)
		req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, secret))
		req.Header.Set("X-GitHub-Event", event)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		_ = resp.Body.Close()
		require.Equal(t, http.StatusNoContent, resp.StatusCode)
	}
	send("checked", "check_run")
	send("chatty", "issue_comment")

	seen := func(repo string, class dashboard.EventClass) bool {
		_, ok := manager.LastDelivery(dashboard.ForgeGitHub, "alrayyes/"+repo, class)

		return ok
	}
	require.Eventually(t, func() bool { return seen("checked", dashboard.EventClassCheck) }, time.Second, 5*time.Millisecond, "a check_run delivery marks checks seen")
	require.Eventually(t, func() bool { return seen("chatty", dashboard.EventClassOther) }, time.Second, 5*time.Millisecond)
	assert.False(t, seen("chatty", dashboard.EventClassCheck), "a comment delivery must not mark checks seen")

	_, shaSeen := manager.LastCheckDelivery(dashboard.ForgeGitHub, "alrayyes/checked", headSHA)
	assert.True(t, shaSeen, "a check delivery marks the commit it is about")
	_, otherSeen := manager.LastCheckDelivery(dashboard.ForgeGitHub, "alrayyes/checked", otherSHA)
	assert.False(t, otherSeen, "and no other commit of the repo")
}
