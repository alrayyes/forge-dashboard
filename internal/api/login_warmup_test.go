package api_test

import (
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	virtualwebauthn "github.com/descope/virtualwebauthn"
	"github.com/stretchr/testify/require"
)

// The first refresh now starts when the process does, so a sign-in that lands
// while it runs must leave it be: rebuilding would cancel it and the owner
// would wait for a second one.
func TestLogin_WithTheDashboardAlreadyRunning_DoesNotRebuildIt(t *testing.T) {
	t.Parallel()

	var built atomic.Int32
	srv, _, _ := newTestServerWithSourcesAndService(t, func(settingspkg.Credentials) []dashboard.Source {
		built.Add(1)

		return nil
	})
	cookie, cred, authenticator := registerViaRealCeremony(t, srv, testUser, testDisplay)

	put, err := http.NewRequest(http.MethodPut, srv.URL+"/api/settings", strings.NewReader(`{"githubToken":"ghp_x"}`))
	require.NoError(t, err)
	put.AddCookie(cookie)
	put.Header.Set("Content-Type", "application/json")
	resp, err := testClient(t).Do(put)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, int32(1), built.Load(), "the settings save builds the sources once")

	rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}
	begin, err := testClient(t).Post(srv.URL+"/api/auth/login/begin", "application/json", strings.NewReader(`{"username":"`+testUser+`"}`))
	require.NoError(t, err)
	defer func() { _ = begin.Body.Close() }()
	options, err := io.ReadAll(begin.Body)
	require.NoError(t, err)
	parsed, err := virtualwebauthn.ParseAssertionOptions(string(options))
	require.NoError(t, err)
	finish, err := testClient(t).Post(srv.URL+"/api/auth/login/finish?username="+testUser, "application/json",
		strings.NewReader(virtualwebauthn.CreateAssertionResponse(rp, authenticator, cred, *parsed)))
	require.NoError(t, err)
	_ = finish.Body.Close()
	require.Equal(t, http.StatusOK, finish.StatusCode)

	require.Equal(t, int32(1), built.Load(), "signing in must not build the sources again")
}
