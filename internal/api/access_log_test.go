package api_test

import (
	"bytes"
	"database/sql"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	authpkg "github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

// withCapturedLogs swaps the global slog default for a handler writing to
// buf at the given level, restoring the previous default on cleanup — the
// same pattern TestWebhookEnsure_EnsureWebhookFails_LogsTheError already
// uses. Not t.Parallel(): it mutates global state.
func withCapturedLogs(t *testing.T, level slog.Level) *bytes.Buffer {
	t.Helper()
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: level})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &logs
}

func TestAccessLog_UnauthenticatedRequest_LogsMethodPathStatusDuration(t *testing.T) {
	logs := withCapturedLogs(t, slog.LevelInfo)
	srv := newTestServer(t)

	resp, err := http.Get(srv.URL + "/api/version")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	logged := logs.String()
	assert.Contains(t, logged, "level=INFO")
	assert.Contains(t, logged, "method=GET")
	assert.Contains(t, logged, "path=/api/version")
	assert.Contains(t, logged, "status=200")
	assert.Contains(t, logged, "duration_ms=")
	assert.Contains(t, logged, "remote_addr=")
}

func TestAccessLog_RejectedRequest_StillLogsAtWarn(t *testing.T) {
	logs := withCapturedLogs(t, slog.LevelInfo)
	srv := newTestServer(t)

	// No session cookie, no bearer token — RequireAuth rejects this
	// before the handler underneath ever runs. The middleware wraps
	// *outside* auth specifically so this still gets logged.
	resp, err := http.Get(srv.URL + "/api/auth/session")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)

	logged := logs.String()
	assert.Contains(t, logged, "level=WARN")
	assert.Contains(t, logged, "status=401")
	assert.Contains(t, logged, "path=/api/auth/session")
}

func TestAccessLog_AuthenticatedRequest_IncludesUsername(t *testing.T) {
	logs := withCapturedLogs(t, slog.LevelInfo)
	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/session", nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	logged := logs.String()
	assert.Contains(t, logged, "level=INFO")
	assert.Contains(t, logged, "status=200")
	assert.Contains(t, logged, "username="+testUser)
}

func TestAccessLog_NeverLogsAuthorizationHeaderOrQueryString(t *testing.T) {
	logs := withCapturedLogs(t, slog.LevelInfo)
	srv := newTestServer(t)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/version?token=leak-me-not", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer super-secret-value")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	logged := logs.String()
	assert.NotContains(t, logged, "super-secret-value")
	assert.NotContains(t, logged, "leak-me-not")
	assert.NotContains(t, logged, "token=")
}

func TestAccessLog_Healthz_SuppressedAtDefaultInfoLevel(t *testing.T) {
	logs := withCapturedLogs(t, slog.LevelInfo)
	srv := newTestServer(t)

	resp, err := http.Get(srv.URL + "/healthz")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	assert.Empty(t, logs.String(), "a healthy /healthz poll shouldn't drown out real activity at the default level")
}

func TestAccessLog_Healthz_StillLoggedAtDebug(t *testing.T) {
	logs := withCapturedLogs(t, slog.LevelDebug)
	srv := newTestServer(t)

	resp, err := http.Get(srv.URL + "/healthz")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	logged := logs.String()
	assert.Contains(t, logged, "level=DEBUG")
	assert.Contains(t, logged, "path=/healthz")
}

// TestAccessLog_5xxStatus_LogsAtError forces a real 500 the same way
// RequireAuth itself produces one: a session lookup that fails for a
// reason other than "not found" (ErrNotFound is the expected/401 case).
// Closing the underlying DB after a real session already exists is the
// simplest deterministic way to get there without a handler-specific
// fault-injection hook this codebase doesn't otherwise need.
func TestAccessLog_5xxStatus_LogsAtError(t *testing.T) {
	logs := withCapturedLogs(t, slog.LevelInfo)

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "app.db"))
	require.NoError(t, err)
	authStore := authpkg.NewStore(db)
	require.NoError(t, authStore.Init(t.Context()))

	mux := api.NewMux(api.Deps{Version: testVersion, AuthStore: authStore})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	u, err := authStore.CreateUser(t.Context(), testUser, testDisplay, false)
	require.NoError(t, err)
	token, err := authStore.CreateSession(t.Context(), u.ID, time.Hour)
	require.NoError(t, err)

	require.NoError(t, db.Close())

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/session", nil)
	require.NoError(t, err)
	// #nosec G124 -- a request Cookie header being simulated here, not a response Set-Cookie; Secure/HttpOnly/SameSite are response-only attributes gosec cannot tell don't apply.
	req.AddCookie(&http.Cookie{Name: authpkg.CookieName, Value: token})
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusInternalServerError, resp.StatusCode)

	logged := logs.String()
	assert.Contains(t, logged, "level=ERROR")
	assert.Contains(t, logged, "status=500")
}
