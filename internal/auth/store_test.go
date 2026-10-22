package auth_test

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/base64"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"modernc.org/sqlite"
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
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "auth.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))

	return store
}

func TestStore_CreateUser_RoundTripsByUsername(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	created, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	got, err := store.GetUserByUsername(t.Context(), "ryan")
	require.NoError(t, err)

	assert.Equal(t, created.ID, got.ID)
	assert.Equal(t, "Ryan", got.DisplayName)
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

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	cred := webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}
	require.NoError(t, store.AddCredential(t.Context(), cred))

	cred.Authenticator.SignCount = 7
	require.NoError(t, store.UpdateCredential(t.Context(), cred))

	got, err := store.Owner(t.Context())
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

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	token, err := store.CreateSession(t.Context(), time.Hour)
	require.NoError(t, err)
	require.NotEmpty(t, token)

	got, err := store.UserForSession(t.Context(), token)
	require.NoError(t, err)
	assert.Equal(t, u.Username, got.Username)
}

func TestStore_Session_Expired_IsRefused(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	token, err := store.CreateSession(t.Context(), -time.Second)
	require.NoError(t, err)

	_, err = store.UserForSession(t.Context(), token)

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_Session_Deleted_IsRefused(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	token, err := store.CreateSession(t.Context(), time.Hour)
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

func TestStore_ClaimUnregisteredUser_NoRowYet_CreatesOne(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.ClaimUnregisteredUser(t.Context(), "ryan", "Ryan", time.Time{})
	require.NoError(t, err)

	got, err := store.GetUserByUsername(t.Context(), "ryan")
	require.NoError(t, err)
	assert.Equal(t, u.ID, got.ID)
}

func TestStore_ClaimUnregisteredUser_ADeadEndRowIsReusedAndOthersAreDropped(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	first, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	_, err = store.CreateUser(t.Context(), "stray", "Stray")
	require.NoError(t, err)

	claimed, err := store.ClaimUnregisteredUser(t.Context(), "ryan", "Ryan K", time.Now().Add(time.Minute))
	require.NoError(t, err)

	assert.Equal(t, first.ID, claimed.ID, "the oldest row is the owner's")
	_, err = store.GetUserByUsername(t.Context(), "stray")
	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_ClaimUnregisteredUser_SweepsTheCeremoniesOfEveryUserItDrops(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	session := webauthn.SessionData{Challenge: "c"}

	_, err := store.CreateUser(t.Context(), "owner", "Owner")
	require.NoError(t, err)
	_, err = store.CreateUser(t.Context(), "stale", "Stale")
	require.NoError(t, err)
	require.NoError(t, store.SaveCeremony(t.Context(), "stale", "registration", session, time.Minute))

	_, err = store.ClaimUnregisteredUser(t.Context(), "owner", "Owner", time.Now().Add(time.Hour))
	require.NoError(t, err)

	_, err = store.LoadCeremony(t.Context(), "stale", "registration")
	assert.ErrorIs(t, err, auth.ErrNotFound, "a dropped user's ceremony must not outlive it")
}

func TestStore_AddFirstCredential_SweepsTheCeremoniesOfTheUsersItClears(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	session := webauthn.SessionData{Challenge: "c"}

	winner, err := store.CreateUser(t.Context(), "winner", "Winner")
	require.NoError(t, err)
	_, err = store.CreateUser(t.Context(), "stale", "Stale")
	require.NoError(t, err)
	require.NoError(t, store.SaveCeremony(t.Context(), "stale", "registration", session, time.Minute))

	require.NoError(t, store.AddFirstCredential(t.Context(), winner.ID, "winner", webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	_, err = store.LoadCeremony(t.Context(), "stale", "registration")
	assert.ErrorIs(t, err, auth.ErrNotFound, "a cleared user's ceremony must not outlive it")
}

func TestStore_ClaimUnregisteredUser_LeavesARegisteredUserAlone(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	_, err = store.ClaimUnregisteredUser(t.Context(), "alex", "Alex", time.Time{})
	require.NoError(t, err)

	got, err := store.GetUserByUsername(t.Context(), "ryan")
	require.NoError(t, err)
	assert.Len(t, got.Credentials, 1)
}

func TestStore_AddFirstCredential_NobodyRegisteredYet_AttachesThePasskey(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	u, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	require.NoError(t, store.AddFirstCredential(t.Context(), u.ID, "ryan", webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	got, err := store.Owner(t.Context())
	require.NoError(t, err)
	assert.Len(t, got.Credentials, 1)
}

func TestStore_AddFirstCredential_AnotherUserHoldsAPasskey_ReturnsErrRegistrationClosed(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	winner, err := store.CreateUser(t.Context(), "winner", "Winner")
	require.NoError(t, err)
	loser, err := store.CreateUser(t.Context(), "loser", "Loser")
	require.NoError(t, err)
	require.NoError(t, store.AddFirstCredential(t.Context(), winner.ID, "winner", webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	err = store.AddFirstCredential(t.Context(), loser.ID, "loser", webauthn.Credential{ID: []byte("cred-2"), PublicKey: []byte("pk")})

	assert.ErrorIs(t, err, auth.ErrRegistrationClosed)
}

func TestStore_AddFirstCredential_Refused_RemovesThePendingUser(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	winner, err := store.CreateUser(t.Context(), "winner", "Winner")
	require.NoError(t, err)
	loser, err := store.CreateUser(t.Context(), "loser", "Loser")
	require.NoError(t, err)
	require.NoError(t, store.AddFirstCredential(t.Context(), winner.ID, "winner", webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	_ = store.AddFirstCredential(t.Context(), loser.ID, "loser", webauthn.Credential{ID: []byte("cred-2"), PublicKey: []byte("pk")})

	_, err = store.GetUserByUsername(t.Context(), "loser")
	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_AddFirstCredential_TakesTheUsernameOfTheFinishingCeremony(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	u, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	_, err = store.CreateUser(t.Context(), "stray", "Stray")
	require.NoError(t, err)

	require.NoError(t, store.AddFirstCredential(t.Context(), u.ID, "stray", webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	got, err := store.GetUserByUsername(t.Context(), "stray")
	require.NoError(t, err)
	assert.Equal(t, u.ID, got.ID, "the winner's row takes its username, even one an abandoned attempt held")
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
	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	has, err := store.HasAnyRegisteredUser(t.Context())
	require.NoError(t, err)
	assert.False(t, has, "an abandoned registration shouldn't count as a real user existing")
}

func TestStore_HasAnyRegisteredUser_CompletedRegistration_ReportsTrue(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	has, err := store.HasAnyRegisteredUser(t.Context())
	require.NoError(t, err)
	assert.True(t, has)
}

// TestStore_RevokeUser_AlsoRevokesAPITokens is a regression test for the
// same "signed out everywhere" gap DeleteUser already had to cover for
// sessions — an API token is another way to authenticate as this user,
// so revoking has to reach it too, not just the session-cookie path.
// TestStore_DeleteUser_AlsoRemovesAPITokens is the same regression
// coverage TestStore_RevokeUser_AlsoRevokesAPITokens is, for the
// account-deletion path instead of the revoke-in-place one.
func TestStore_APIToken_CreateThenResolve_ReturnsTheOwner(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	rawToken, tok, err := store.CreateAPIToken(t.Context(), "laptop", time.Now().Add(30*24*time.Hour))
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

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	rawToken, tok, err := store.CreateAPIToken(t.Context(), "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	tokens, err := store.ListAPITokens(t.Context())
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

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	rawToken, _, err := store.CreateAPIToken(t.Context(), "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	_, err = store.UserForAPIToken(t.Context(), rawToken)
	require.NoError(t, err)

	tokens, err := store.ListAPITokens(t.Context())
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	require.NotNil(t, tokens[0].LastUsedAt)
	assert.WithinDuration(t, time.Now().UTC(), *tokens[0].LastUsedAt, 5*time.Second)
}

func TestStore_APIToken_Delete_StopsItAuthenticating(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	rawToken, tok, err := store.CreateAPIToken(t.Context(), "laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	require.NoError(t, store.DeleteAPIToken(t.Context(), tok.ID))

	_, err = store.UserForAPIToken(t.Context(), rawToken)
	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_APIToken_Delete_UnknownID_IsIdempotent(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	err = store.DeleteAPIToken(t.Context(), "not-a-real-id")

	assert.NoError(t, err)
}

func TestStore_APIToken_List_OrderedOldestFirst(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	_, first, err := store.CreateAPIToken(t.Context(), "first", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)
	_, second, err := store.CreateAPIToken(t.Context(), "second", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)

	tokens, err := store.ListAPITokens(t.Context())

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

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	wantExpiry := time.Now().Add(90 * 24 * time.Hour)

	_, tok, err := store.CreateAPIToken(t.Context(), "laptop", wantExpiry)
	require.NoError(t, err)
	assert.WithinDuration(t, wantExpiry, tok.ExpiresAt, time.Second)

	tokens, err := store.ListAPITokens(t.Context())
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

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	rawToken, _, err := store.CreateAPIToken(t.Context(), "laptop", time.Now().Add(-time.Minute))
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

	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "auth.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))

	_, err = store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	rawToken, _, err := store.CreateAPIToken(t.Context(), "old laptop", time.Now().Add(30*24*time.Hour))
	require.NoError(t, err)
	_, err = db.ExecContext(t.Context(), `UPDATE api_tokens SET expires_at = NULL`)
	require.NoError(t, err)

	_, err = store.UserForAPIToken(t.Context(), rawToken)

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_ListCredentials_NoneYet_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	creds, err := store.ListCredentials(t.Context())

	require.NoError(t, err)
	assert.Empty(t, creds)
}

func TestStore_SetCredentialLabel_ThenListCredentials_ReturnsIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	credID := []byte("cred-1")
	require.NoError(t, store.AddCredential(t.Context(), webauthn.Credential{ID: credID, PublicKey: []byte("pk")}))
	require.NoError(t, store.SetCredentialLabel(t.Context(), credID, "MacBook"))

	creds, err := store.ListCredentials(t.Context())

	require.NoError(t, err)
	require.Len(t, creds, 1)
	assert.Equal(t, "MacBook", creds[0].Label)
	assert.False(t, creds[0].CreatedAt.IsZero())
}

func TestStore_SetCredentialLabel_Twice_ReplacesIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	credID := []byte("cred-1")
	require.NoError(t, store.AddCredential(t.Context(), webauthn.Credential{ID: credID, PublicKey: []byte("pk")}))
	require.NoError(t, store.SetCredentialLabel(t.Context(), credID, "MacBook"))

	require.NoError(t, store.SetCredentialLabel(t.Context(), credID, "Work Laptop"))

	creds, err := store.ListCredentials(t.Context())
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

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	creds, err := store.ListCredentials(t.Context())

	require.NoError(t, err)
	require.Len(t, creds, 1)
	assert.NotEmpty(t, creds[0].Label)
}

func TestStore_RemoveCredential_WithAnotherRemaining_RemovesIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
	require.NoError(t, store.SetCredentialLabel(t.Context(), []byte("cred-1"), "MacBook"))
	require.NoError(t, store.AddCredential(t.Context(), webauthn.Credential{ID: []byte("cred-2"), PublicKey: []byte("pk2")}))
	require.NoError(t, store.SetCredentialLabel(t.Context(), []byte("cred-2"), "YubiKey"))

	require.NoError(t, store.RemoveCredential(t.Context(), credentialIDKeyForTest([]byte("cred-1"))))

	got, err := store.Owner(t.Context())
	require.NoError(t, err)
	require.Len(t, got.Credentials, 1)
	assert.Equal(t, []byte("cred-2"), got.Credentials[0].ID)

	creds, err := store.ListCredentials(t.Context())
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

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	err = store.RemoveCredential(t.Context(), credentialIDKeyForTest([]byte("cred-1")))

	//nolint:testifylint // deliberately assert, not require: whether the
	// credential survived is worth checking independently of which exact
	// error came back.
	assert.ErrorIs(t, err, auth.ErrLastCredential)
	got, getErr := store.Owner(t.Context())
	require.NoError(t, getErr)
	assert.Len(t, got.Credentials, 1, "the credential must survive a refused delete")
}

func TestStore_RemoveCredential_UnknownID_IsIdempotent(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	err = store.RemoveCredential(t.Context(), "not-a-real-credential-id")

	assert.NoError(t, err)
}

// A database created while invites and the admin flag existed keeps its users,
// and loses the invites table and users.is_admin on the next start.
func TestStore_Init_DropsTheInviteMachineryAnOlderDatabaseHad(t *testing.T) {
	t.Parallel()
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "auth.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	for _, stmt := range []string{
		`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
			is_admin INTEGER NOT NULL DEFAULT 0, credentials_json TEXT NOT NULL DEFAULT '[]', created_at TIMESTAMP NOT NULL)`,
		`INSERT INTO users (id, username, display_name, is_admin, created_at) VALUES ('aWQ', 'ryan', 'Ryan', 1, '2026-01-01T00:00:00Z')`,
		`CREATE TABLE invites (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL,
			created_by TEXT NOT NULL REFERENCES users(id), expires_at TIMESTAMP NOT NULL, consumed_at TIMESTAMP)`,
	} {
		_, err := db.ExecContext(t.Context(), stmt)
		require.NoError(t, err)
	}
	store := auth.NewStore(db)

	require.NoError(t, store.Init(t.Context()))
	require.NoError(t, store.Init(t.Context()), "a second start finds nothing left to drop")

	var invites, isAdmin int
	require.NoError(t, db.QueryRowContext(t.Context(), `SELECT count(*) FROM sqlite_master WHERE name = 'invites'`).Scan(&invites))
	require.NoError(t, db.QueryRowContext(t.Context(), `SELECT count(*) FROM pragma_table_info('users') WHERE name = 'is_admin'`).Scan(&isAdmin))
	assert.Zero(t, invites)
	assert.Zero(t, isAdmin)
	got, err := store.GetUserByUsername(t.Context(), "ryan")
	require.NoError(t, err)
	assert.Equal(t, "Ryan", got.DisplayName)
}

func newOwnerWithEverything(t *testing.T, store *auth.Store) *auth.User {
	t.Helper()
	u, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
	require.NoError(t, store.SetCredentialLabel(t.Context(), []byte("cred-1"), "Laptop"))
	_, err = store.CreateSession(t.Context(), time.Hour)
	require.NoError(t, err)
	_, _, err = store.CreateAPIToken(t.Context(), "ci", time.Time{})
	require.NoError(t, err)

	return u
}

func TestStore_Owner_NoUser_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.Owner(t.Context())

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestStore_ResetPasskeys_ClearsPasskeysAndSessionsAndKeepsTheRowAndTokens(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	_ = newOwnerWithEverything(t, store)

	res, err := store.ResetPasskeys(t.Context(), false)
	require.NoError(t, err)

	assert.Equal(t, auth.ResetResult{Username: "ryan", Passkeys: 1, Sessions: 1}, res)
	got, err := store.Owner(t.Context())
	require.NoError(t, err, "the row, and so its id, is what the settings hang off")
	assert.Empty(t, got.Credentials)
	creds, err := store.ListCredentials(t.Context())
	require.NoError(t, err)
	assert.Empty(t, creds)
	tokens, err := store.ListAPITokens(t.Context())
	require.NoError(t, err)
	assert.Len(t, tokens, 1)
	registered, err := store.HasAnyRegisteredUser(t.Context())
	require.NoError(t, err)
	assert.False(t, registered, "registration is open again")
}

func TestStore_ResetPasskeys_WithTokens_RevokesThemToo(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	_ = newOwnerWithEverything(t, store)

	res, err := store.ResetPasskeys(t.Context(), true)
	require.NoError(t, err)

	assert.Equal(t, 1, res.Tokens)
	tokens, err := store.ListAPITokens(t.Context())
	require.NoError(t, err)
	assert.Empty(t, tokens)
}

func TestStore_ResetPasskeys_NoUser_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.ResetPasskeys(t.Context(), false)

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

// execRecorder wraps the SQLite driver and notes every statement executed.
type execRecorder struct {
	dsn  string
	mu   *sync.Mutex
	seen *[]string
}

type recordingConn struct {
	driver.Conn
	rec execRecorder
}

func (c recordingConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.rec.mu.Lock()
	*c.rec.seen = append(*c.rec.seen, query)
	c.rec.mu.Unlock()

	res, err := c.Conn.(driver.ExecerContext).ExecContext(ctx, query, args)
	if err != nil {
		return nil, fmt.Errorf("exec: %w", err)
	}

	return res, nil
}

func (r execRecorder) Driver() driver.Driver { return &sqlite.Driver{} }

func (r execRecorder) Connect(context.Context) (driver.Conn, error) {
	conn, err := (&sqlite.Driver{}).Open(r.dsn)
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}

	return recordingConn{Conn: conn, rec: r}, nil
}

// A database that already lost is_admin is not asked to drop it again: Init
// looks at the table first instead of running the ALTER and reading the error.
func TestStore_Init_DoesNotAttemptToDropAColumnThatIsGone(t *testing.T) {
	t.Parallel()
	dsn := dbdsn.For(filepath.Join(t.TempDir(), "auth.db"))
	var (
		mu   sync.Mutex
		seen []string
	)
	db := sql.OpenDB(execRecorder{dsn: dsn, mu: &mu, seen: &seen})
	t.Cleanup(func() { _ = db.Close() })
	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))

	mu.Lock()
	seen = nil
	mu.Unlock()
	require.NoError(t, store.Init(t.Context()))

	mu.Lock()
	defer mu.Unlock()
	for _, q := range seen {
		assert.NotContains(t, q, "DROP COLUMN", "a second start has nothing to drop")
	}
}
