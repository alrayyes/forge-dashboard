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

// TestWithAccessLogUsername_RequireAuthFillsTheSlot is #371's own
// mechanism for letting an access-log middleware — which has to wrap
// *outside* RequireAuth, so a rejected/unauthenticated request still gets
// logged — observe the username RequireAuth resolves *inside* itself.
// r.WithContext returns a new *http.Request rather than mutating the
// caller's own, so the outer middleware's own request/context never sees
// values a downstream handler adds to its context normally; the slot this
// returns is a pointer carried *through* that context instead, so writing
// to what it points at is visible to whoever's still holding the same
// pointer, regardless of how many WithContext copies sit in between.
func TestWithAccessLogUsername_RequireAuthFillsTheSlot(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	token, err := store.CreateSession(t.Context(), u.ID, time.Hour)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	// #nosec G124 -- a request Cookie header being simulated here, not a response Set-Cookie; Secure/HttpOnly/SameSite are response-only attributes gosec cannot tell don't apply.
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})

	ctx, slot := auth.WithAccessLogUsername(req.Context())
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()

	auth.RequireAuth(store)(handlerEchoingUsername()).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "ryan", *slot)
}

func TestWithAccessLogUsername_RejectedRequest_SlotStaysEmpty(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	ctx, slot := auth.WithAccessLogUsername(req.Context())
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()

	auth.RequireAuth(store)(handlerEchoingUsername()).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Empty(t, *slot)
}
