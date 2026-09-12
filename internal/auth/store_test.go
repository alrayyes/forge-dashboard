package auth_test

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func newTestStore(t *testing.T) *auth.Store {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "auth.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))
	return store
}

func TestStore_CreateUser_RoundTripsByUsername(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	created, err := store.CreateUser(t.Context(), "ryan", "Ryan", true)
	require.NoError(t, err)

	got, err := store.GetUserByUsername(t.Context(), "ryan")
	require.NoError(t, err)

	assert.Equal(t, created.ID, got.ID)
	assert.Equal(t, "Ryan", got.DisplayName)
	assert.True(t, got.IsAdmin)
	assert.Empty(t, got.Credentials)
}

func TestStore_GetUserByUsername_UnknownUser_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.GetUserByUsername(t.Context(), "nobody")

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_AddCredential_ThenUpdateCredential_PersistsSignCountBump(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)

	cred := webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}
	require.NoError(t, store.AddCredential(t.Context(), u.ID, cred))

	cred.Authenticator.SignCount = 7
	require.NoError(t, store.UpdateCredential(t.Context(), u.ID, cred))

	got, err := store.GetUserByID(t.Context(), u.ID)
	require.NoError(t, err)
	require.Len(t, got.Credentials, 1)
	assert.Equal(t, uint32(7), got.Credentials[0].Authenticator.SignCount)
}

func TestStore_Ceremony_SaveThenLoad_RoundTrips(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	session := webauthn.SessionData{Challenge: "abc123", UserID: []byte("user-id")}
	require.NoError(t, store.SaveCeremony(t.Context(), "ryan", "login", session, time.Minute))

	got, err := store.LoadCeremony(t.Context(), "ryan", "login")
	require.NoError(t, err)
	assert.Equal(t, session.Challenge, got.Challenge)
	assert.Equal(t, session.UserID, got.UserID)
}

func TestStore_Ceremony_Expired_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	session := webauthn.SessionData{Challenge: "abc123"}
	require.NoError(t, store.SaveCeremony(t.Context(), "ryan", "login", session, -time.Second))

	_, err := store.LoadCeremony(t.Context(), "ryan", "login")

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_Ceremony_Delete_MakesItUnloadable(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	session := webauthn.SessionData{Challenge: "abc123"}
	require.NoError(t, store.SaveCeremony(t.Context(), "ryan", "login", session, time.Minute))
	require.NoError(t, store.DeleteCeremony(t.Context(), "ryan", "login"))

	_, err := store.LoadCeremony(t.Context(), "ryan", "login")

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_Session_CreateThenResolve_ReturnsTheOwner(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)

	token, err := store.CreateSession(t.Context(), u.ID, time.Hour)
	require.NoError(t, err)
	require.NotEmpty(t, token)

	got, err := store.UserForSession(t.Context(), token)
	require.NoError(t, err)
	assert.Equal(t, u.Username, got.Username)
}

func TestStore_Session_Expired_IsRefused(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)

	token, err := store.CreateSession(t.Context(), u.ID, -time.Second)
	require.NoError(t, err)

	_, err = store.UserForSession(t.Context(), token)

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_Session_Deleted_IsRefused(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)

	token, err := store.CreateSession(t.Context(), u.ID, time.Hour)
	require.NoError(t, err)
	require.NoError(t, store.DeleteSession(t.Context(), token))

	_, err = store.UserForSession(t.Context(), token)

	assert.True(t, errors.Is(err, auth.ErrNotFound))
}

func TestStore_UnknownSessionToken_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.UserForSession(t.Context(), "not-a-real-token")

	assert.ErrorIs(t, err, auth.ErrNotFound)
}
