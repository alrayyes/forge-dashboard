package auth_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func handlerEchoingUsername() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			http.Error(w, "no user in context", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(u.Username))
	})
}

func TestRequireAuth_SessionCookie_Authenticates(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	token, err := store.CreateSession(t.Context(), u.ID, time.Hour)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	// #nosec G124 -- a request Cookie header being simulated here, not a response Set-Cookie; Secure/HttpOnly/SameSite are response-only attributes gosec cannot tell don't apply.
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	rec := httptest.NewRecorder()

	auth.RequireAuth(store)(handlerEchoingUsername()).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "ryan", rec.Body.String())
}

func TestRequireAuth_BearerToken_AuthenticatesWithNoSessionCookie(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	rawToken, _, err := store.CreateAPIToken(t.Context(), u.ID, "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+rawToken)
	rec := httptest.NewRecorder()

	auth.RequireAuth(store)(handlerEchoingUsername()).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "ryan", rec.Body.String())
}

func TestRequireAuth_SessionCookiePreferredOverBearerWhenBothPresent(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	cookieUser, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	token, err := store.CreateSession(t.Context(), cookieUser.ID, time.Hour)
	require.NoError(t, err)

	bearerUser, err := store.CreateUser(t.Context(), "mallory", "Mallory", false)
	require.NoError(t, err)
	rawToken, _, err := store.CreateAPIToken(t.Context(), bearerUser.ID, "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	// #nosec G124 -- a request Cookie header being simulated here, not a response Set-Cookie; Secure/HttpOnly/SameSite are response-only attributes gosec cannot tell don't apply.
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	req.Header.Set("Authorization", "Bearer "+rawToken)
	rec := httptest.NewRecorder()

	auth.RequireAuth(store)(handlerEchoingUsername()).ServeHTTP(rec, req)

	assert.Equal(t, "ryan", rec.Body.String())
}

func TestRequireAuth_NoCredentialAtAll_Returns401(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	auth.RequireAuth(store)(handlerEchoingUsername()).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestRequireAuth_InvalidBearerToken_Returns401(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer fdb_not-a-real-token")
	rec := httptest.NewRecorder()

	auth.RequireAuth(store)(handlerEchoingUsername()).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestRequireAuth_RevokedBearerToken_Returns401(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	rawToken, tok, err := store.CreateAPIToken(t.Context(), u.ID, "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)
	require.NoError(t, store.DeleteAPIToken(t.Context(), u.ID, tok.ID))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+rawToken)
	rec := httptest.NewRecorder()

	auth.RequireAuth(store)(handlerEchoingUsername()).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}
