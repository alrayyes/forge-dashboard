package api_test

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	authpkg "github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/require"
)

const testPublicOrigin = "https://dashboard.example"

// newTestServerWithForgeSource registers a user, saves credentials for
// forge (so BuildSources actually returns source), and returns the
// server URL and session cookie.
func newTestServerWithForgeSource(t *testing.T, forge dashboard.Forge, source dashboard.Source) (srv string, sessionCookie *http.Cookie) {
	t.Helper()
	buildSources := func(c settingspkg.Credentials) []dashboard.Source {
		if forge == dashboard.ForgeGitHub && c.GitHubToken == "" {
			return nil
		}
		if forge == dashboard.ForgeForgejo && c.ForgejoToken == "" {
			return nil
		}

		return []dashboard.Source{source}
	}

	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "app.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	authStore := authpkg.NewStore(db)
	require.NoError(t, authStore.Init(t.Context()))

	wa, err := webauthn.New(&webauthn.Config{
		RPID:          testRPID,
		RPDisplayName: "Forge Board Test",
		RPOrigins:     []string{testOrigin},
	})
	require.NoError(t, err)
	authService := authpkg.NewService(wa, authStore)

	cipher, err := settingspkg.NewCipher(testEncryptionKey(t))
	require.NoError(t, err)
	settingsStore := settingspkg.NewStore(db, cipher)
	require.NoError(t, settingsStore.Init(t.Context()))

	service := dashboard.NewService(time.Hour)
	t.Cleanup(service.Stop)

	appCtx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	mux := api.NewMux(api.Deps{
		Version:       testVersion,
		AuthService:   authService,
		AuthStore:     authStore,
		SettingsStore: settingsStore,
		Service:       service,
		BuildSources:  buildSources,
		AppContext:    appCtx,
		PublicOrigin:  testPublicOrigin,
	})
	testSrv := httptest.NewServer(mux)
	t.Cleanup(testSrv.Close)
	testSettingsStores.Store(testSrv.URL, settingsStore)
	t.Cleanup(func() { testSettingsStores.Delete(testSrv.URL) })

	sessionCookie, _, _ = registerViaRealCeremony(t, testSrv)

	body := `{"githubToken":"placeholder-token","forgejoUrl":"https://git.example","forgejoToken":"placeholder-token"}`
	putReq, err := http.NewRequest(http.MethodPut, testSrv.URL+"/api/v1/settings", strings.NewReader(body))
	require.NoError(t, err)
	putReq.AddCookie(sessionCookie)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := testClient(t).Do(putReq)
	require.NoError(t, err)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	return testSrv.URL, sessionCookie
}
