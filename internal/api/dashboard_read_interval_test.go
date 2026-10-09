package api_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// A client follows the server's advice on how often to re-read the
// dashboard instead of keeping an interval of its own (#809).
func TestDashboard_AdvisesHowOftenToRead(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	body := fetchDashboardWith(t, srv.URL, sessionCookie, "")

	assert.InDelta(t, 30, body["readIntervalSeconds"], 0)
}
