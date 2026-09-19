package auth_test

import (
	"database/sql"
	"encoding/base64"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

// credentialIDKeyForTest mirrors the unexported encoding
// Store.RemoveCredential's own credID string parameter expects — the
// same base64url a real Credential.ID (from ListCredentials) already
// carries, not something a test outside this package can otherwise
// produce without reaching past AddCredential's own []byte ID.
func credentialIDKeyForTest(id []byte) string {
	return base64.RawURLEncoding.EncodeToString(id)
}

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

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_UnknownSessionToken_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.UserForSession(t.Context(), "not-a-real-token")

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_DeleteUnregisteredUser_RemovesAUserWithNoCredentials(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)

	require.NoError(t, store.DeleteUnregisteredUser(t.Context(), "ryan"))

	_, err = store.GetUserByUsername(t.Context(), "ryan")
	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_DeleteUnregisteredUser_LeavesARegisteredUserAlone(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	require.NoError(t, store.DeleteUnregisteredUser(t.Context(), "ryan"))

	got, err := store.GetUserByUsername(t.Context(), "ryan")
	require.NoError(t, err)
	assert.Len(t, got.Credentials, 1)
}

func TestStore_HasAnyRegisteredUser_NoUsersYet_ReportsFalse(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	has, err := store.HasAnyRegisteredUser(t.Context())
	require.NoError(t, err)
	assert.False(t, has)
}

func TestStore_HasAnyRegisteredUser_UnfinishedRegistration_StillReportsFalse(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	// CreateUser alone is what BeginRegistration does before the ceremony
	// finishes — a row exists, but nothing was ever actually completed.
	_, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)

	has, err := store.HasAnyRegisteredUser(t.Context())
	require.NoError(t, err)
	assert.False(t, has, "an abandoned registration shouldn't count as a real user existing")
}

func TestStore_HasAnyRegisteredUser_CompletedRegistration_ReportsTrue(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	has, err := store.HasAnyRegisteredUser(t.Context())
	require.NoError(t, err)
	assert.True(t, has)
}

func TestStore_ListUsers_ReturnsEveryRegisteredUser(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan", true)
	require.NoError(t, err)
	_, err = store.CreateUser(t.Context(), "alex", "Alex", false)
	require.NoError(t, err)

	users, err := store.ListUsers(t.Context())
	require.NoError(t, err)

	require.Len(t, users, 2)
	usernames := []string{users[0].Username, users[1].Username}
	assert.ElementsMatch(t, []string{"ryan", "alex"}, usernames)
}

func TestStore_RevokeUser_ClearsCredentialsAndSessions(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
	token, err := store.CreateSession(t.Context(), u.ID, time.Hour)
	require.NoError(t, err)

	require.NoError(t, store.RevokeUser(t.Context(), u.ID))

	got, err := store.GetUserByID(t.Context(), u.ID)
	require.NoError(t, err)
	assert.Empty(t, got.Credentials)

	_, err = store.UserForSession(t.Context(), token)
	assert.ErrorIs(t, err, auth.ErrNotFound)
}

// TestStore_RevokeUser_AlsoRevokesAPITokens is a regression test for the
// same "signed out everywhere" gap DeleteUser already had to cover for
// sessions — an API token is another way to authenticate as this user,
// so revoking has to reach it too, not just the session-cookie path.
func TestStore_RevokeUser_AlsoRevokesAPITokens(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	rawToken, _, err := store.CreateAPIToken(t.Context(), u.ID, "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	require.NoError(t, store.RevokeUser(t.Context(), u.ID))

	_, err = store.UserForAPIToken(t.Context(), rawToken)
	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_DeleteUser_RemovesTheAccountAndItsSessions(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	token, err := store.CreateSession(t.Context(), u.ID, time.Hour)
	require.NoError(t, err)

	require.NoError(t, store.DeleteUser(t.Context(), u.ID))

	_, err = store.GetUserByUsername(t.Context(), "ryan")
	assert.ErrorIs(t, err, auth.ErrNotFound)

	_, err = store.UserForSession(t.Context(), token)
	assert.ErrorIs(t, err, auth.ErrNotFound)
}

// TestStore_DeleteUser_AlsoRemovesAPITokens is the same regression
// coverage TestStore_RevokeUser_AlsoRevokesAPITokens is, for the
// account-deletion path instead of the revoke-in-place one.
func TestStore_DeleteUser_AlsoRemovesAPITokens(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	rawToken, _, err := store.CreateAPIToken(t.Context(), u.ID, "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	require.NoError(t, store.DeleteUser(t.Context(), u.ID))

	_, err = store.UserForAPIToken(t.Context(), rawToken)
	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_APIToken_CreateThenResolve_ReturnsTheOwner(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)

	rawToken, tok, err := store.CreateAPIToken(t.Context(), u.ID, "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)
	require.NotEmpty(t, rawToken)
	assert.Equal(t, "laptop", tok.Label)
	assert.Nil(t, tok.LastUsedAt)

	got, err := store.UserForAPIToken(t.Context(), rawToken)
	require.NoError(t, err)
	assert.Equal(t, u.Username, got.Username)
}

// TestStore_APIToken_RawValueNeverStored is the actual security property
// this feature exists for: the raw token can't be recovered from
// anything CreateAPIToken/ListAPITokens hand back except the one create
// response, so a database dump doesn't hand out live credentials.
func TestStore_APIToken_RawValueNeverStored(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	rawToken, tok, err := store.CreateAPIToken(t.Context(), u.ID, "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	tokens, err := store.ListAPITokens(t.Context(), u.ID)
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	assert.Equal(t, tok.ID, tokens[0].ID)
	assert.NotEqual(t, rawToken, tokens[0].ID, "the id is not, and must never be, the raw token")
}

func TestStore_APIToken_UnknownToken_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.UserForAPIToken(t.Context(), "fdb_not-a-real-token")

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_APIToken_Use_RecordsLastUsedAt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	rawToken, _, err := store.CreateAPIToken(t.Context(), u.ID, "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	_, err = store.UserForAPIToken(t.Context(), rawToken)
	require.NoError(t, err)

	tokens, err := store.ListAPITokens(t.Context(), u.ID)
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	require.NotNil(t, tokens[0].LastUsedAt)
	assert.WithinDuration(t, time.Now().UTC(), *tokens[0].LastUsedAt, 5*time.Second)
}

func TestStore_APIToken_Delete_StopsItAuthenticating(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	rawToken, tok, err := store.CreateAPIToken(t.Context(), u.ID, "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	require.NoError(t, store.DeleteAPIToken(t.Context(), u.ID, tok.ID))

	_, err = store.UserForAPIToken(t.Context(), rawToken)
	assert.ErrorIs(t, err, auth.ErrNotFound)
}

// TestStore_APIToken_Delete_ScopedToOwner is the real security property
// of the "scoped to userID" delete — one user's own valid token id must
// be un-guessable-into by another, not just filtered from their own list.
func TestStore_APIToken_Delete_ScopedToOwner(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	owner, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	attacker, err := store.CreateUser(t.Context(), "mallory", "Mallory", false)
	require.NoError(t, err)
	rawToken, tok, err := store.CreateAPIToken(t.Context(), owner.ID, "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	require.NoError(t, store.DeleteAPIToken(t.Context(), attacker.ID, tok.ID))

	got, err := store.UserForAPIToken(t.Context(), rawToken)
	require.NoError(t, err, "the owner's token must survive another user's delete attempt")
	assert.Equal(t, owner.Username, got.Username)
}

func TestStore_APIToken_Delete_UnknownID_IsIdempotent(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)

	err = store.DeleteAPIToken(t.Context(), u.ID, "not-a-real-id")

	assert.NoError(t, err)
}

func TestStore_APIToken_List_OrderedOldestFirst(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	_, first, err := store.CreateAPIToken(t.Context(), u.ID, "first", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)
	_, second, err := store.CreateAPIToken(t.Context(), u.ID, "second", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	tokens, err := store.ListAPITokens(t.Context(), u.ID)

	require.NoError(t, err)
	require.Len(t, tokens, 2)
	assert.Equal(t, first.ID, tokens[0].ID)
	assert.Equal(t, second.ID, tokens[1].ID)
}

// TestStore_APIToken_ExpiresAt_RoundTrips is #356's own acceptance
// criterion that Settings shows each token's expiration alongside its
// other metadata.
func TestStore_APIToken_ExpiresAt_RoundTrips(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	wantExpiry := time.Now().Add(90 * 24 * time.Hour)

	_, tok, err := store.CreateAPIToken(t.Context(), u.ID, "laptop", wantExpiry)
	require.NoError(t, err)
	assert.WithinDuration(t, wantExpiry, tok.ExpiresAt, time.Second)

	tokens, err := store.ListAPITokens(t.Context(), u.ID)
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	assert.WithinDuration(t, wantExpiry, tokens[0].ExpiresAt, time.Second)
}

// TestStore_APIToken_Expired_RejectedLikeAnInvalidToken is #356's core
// security property: an expired token stops authenticating, the same
// ErrNotFound an unknown or already-deleted one gets — not a distinct
// "expired" error a caller could special-case into still trusting it.
func TestStore_APIToken_Expired_RejectedLikeAnInvalidToken(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	rawToken, _, err := store.CreateAPIToken(t.Context(), u.ID, "laptop", time.Now().Add(-time.Minute))
	require.NoError(t, err)

	_, err = store.UserForAPIToken(t.Context(), rawToken)

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

// TestStore_APIToken_LegacyRowWithNoExpiry_RejectedNotGrandfathered is
// the migration case: a token row that predates this column (expires_at
// NULL) must not be silently treated as permanently valid just because
// the schema changed underneath it — #356's whole point is that no
// token gets to be non-expiring, including one that already existed.
// Simulated by creating a real token the normal way, then reaching past
// the Store's own API to null out expires_at directly — the shape a row
// written before this migration would already be in, not something this
// package's own public methods can produce on their own anymore.
func TestStore_APIToken_LegacyRowWithNoExpiry_RejectedNotGrandfathered(t *testing.T) {
	t.Parallel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "auth.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	rawToken, _, err := store.CreateAPIToken(t.Context(), u.ID, "old laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)
	_, err = db.ExecContext(t.Context(), `UPDATE api_tokens SET expires_at = NULL`)
	require.NoError(t, err)

	_, err = store.UserForAPIToken(t.Context(), rawToken)

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_ListCredentials_NoneYet_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)

	creds, err := store.ListCredentials(t.Context(), u.ID)

	require.NoError(t, err)
	assert.Empty(t, creds)
}

func TestStore_SetCredentialLabel_ThenListCredentials_ReturnsIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	credID := []byte("cred-1")
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: credID, PublicKey: []byte("pk")}))
	require.NoError(t, store.SetCredentialLabel(t.Context(), u.ID, credID, "MacBook"))

	creds, err := store.ListCredentials(t.Context(), u.ID)

	require.NoError(t, err)
	require.Len(t, creds, 1)
	assert.Equal(t, "MacBook", creds[0].Label)
	assert.False(t, creds[0].CreatedAt.IsZero())
}

func TestStore_SetCredentialLabel_Twice_ReplacesIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	credID := []byte("cred-1")
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: credID, PublicKey: []byte("pk")}))
	require.NoError(t, store.SetCredentialLabel(t.Context(), u.ID, credID, "MacBook"))

	require.NoError(t, store.SetCredentialLabel(t.Context(), u.ID, credID, "Work Laptop"))

	creds, err := store.ListCredentials(t.Context(), u.ID)
	require.NoError(t, err)
	require.Len(t, creds, 1)
	assert.Equal(t, "Work Laptop", creds[0].Label)
}

// TestStore_ListCredentials_NoMetadataRow_FallsBackRatherThanVanishing
// is the migration case: a credential AddCredential ever attached
// without a matching SetCredentialLabel call (a row from before this
// feature existed) must still appear in the list, not silently vanish
// just because its label is missing.
func TestStore_ListCredentials_NoMetadataRow_FallsBackRatherThanVanishing(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	creds, err := store.ListCredentials(t.Context(), u.ID)

	require.NoError(t, err)
	require.Len(t, creds, 1)
	assert.NotEmpty(t, creds[0].Label)
}

func TestStore_ListCredentials_TwoUsers_EachSeesOnlyTheirOwn(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	a, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), a.ID, webauthn.Credential{ID: []byte("cred-a"), PublicKey: []byte("pk")}))
	require.NoError(t, store.SetCredentialLabel(t.Context(), a.ID, []byte("cred-a"), "Ryan's key"))
	b, err := store.CreateUser(t.Context(), "mallory", "Mallory", false)
	require.NoError(t, err)

	creds, err := store.ListCredentials(t.Context(), b.ID)

	require.NoError(t, err)
	assert.Empty(t, creds)
}

func TestStore_RemoveCredential_WithAnotherRemaining_RemovesIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
	require.NoError(t, store.SetCredentialLabel(t.Context(), u.ID, []byte("cred-1"), "MacBook"))
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: []byte("cred-2"), PublicKey: []byte("pk2")}))
	require.NoError(t, store.SetCredentialLabel(t.Context(), u.ID, []byte("cred-2"), "YubiKey"))

	require.NoError(t, store.RemoveCredential(t.Context(), u.ID, credentialIDKeyForTest([]byte("cred-1"))))

	got, err := store.GetUserByID(t.Context(), u.ID)
	require.NoError(t, err)
	require.Len(t, got.Credentials, 1)
	assert.Equal(t, []byte("cred-2"), got.Credentials[0].ID)

	creds, err := store.ListCredentials(t.Context(), u.ID)
	require.NoError(t, err)
	require.Len(t, creds, 1)
	assert.Equal(t, "YubiKey", creds[0].Label)
}

// TestStore_RemoveCredential_LastOne_RefusedWithErrLastCredential is
// #355's core safety property: this app has no password fallback, so
// deleting the account's only passkey would lock it out entirely.
func TestStore_RemoveCredential_LastOne_RefusedWithErrLastCredential(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	err = store.RemoveCredential(t.Context(), u.ID, credentialIDKeyForTest([]byte("cred-1")))

	assert.ErrorIs(t, err, auth.ErrLastCredential)
	got, getErr := store.GetUserByID(t.Context(), u.ID)
	require.NoError(t, getErr)
	assert.Len(t, got.Credentials, 1, "the credential must survive a refused delete")
}

func TestStore_RemoveCredential_UnknownID_IsIdempotent(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	err = store.RemoveCredential(t.Context(), u.ID, "not-a-real-credential-id")

	assert.NoError(t, err)
}

func TestStore_RemoveCredential_ScopedToOwner(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	owner, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), owner.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
	require.NoError(t, store.AddCredential(t.Context(), owner.ID, webauthn.Credential{ID: []byte("cred-2"), PublicKey: []byte("pk2")}))
	attacker, err := store.CreateUser(t.Context(), "mallory", "Mallory", false)
	require.NoError(t, err)

	require.NoError(t, store.RemoveCredential(t.Context(), attacker.ID, credentialIDKeyForTest([]byte("cred-1"))))

	got, err := store.GetUserByID(t.Context(), owner.ID)
	require.NoError(t, err)
	assert.Len(t, got.Credentials, 2, "the owner's credential must survive another user's delete attempt")
}

func TestStore_RevokeUser_AlsoClearsCredentialMetadata(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
	require.NoError(t, store.SetCredentialLabel(t.Context(), u.ID, []byte("cred-1"), "MacBook"))

	require.NoError(t, store.RevokeUser(t.Context(), u.ID))
	// A revoked account can register fresh credentials again without an
	// old label resurfacing against a same-valued new credential ID.
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk-new")}))

	creds, err := store.ListCredentials(t.Context(), u.ID)
	require.NoError(t, err)
	require.Len(t, creds, 1)
	assert.NotEqual(t, "MacBook", creds[0].Label)
}
