package auth_test

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func newTestService(t *testing.T) (*auth.Service, *auth.Store) {
	t.Helper()
	store := newTestStore(t)
	wa, err := webauthn.New(&webauthn.Config{
		RPID:          "localhost",
		RPDisplayName: "Forge Board Test",
		RPOrigins:     []string{"http://localhost"},
	})
	require.NoError(t, err)

	return auth.NewService(wa, store), store
}

// A reload (or any interruption) between BeginRegistration and
// FinishRegistration leaves a user row with no credential attached — real
// bug, reported live: retrying registration under the same username used
// to fail with ErrAlreadyRegistered forever, and login had nothing to log
// in with either. Nothing was ever actually registered, so the username
// has to stay reclaimable.
func TestBeginRegistration_AbandonedRegistration_CanBeReclaimed(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)

	_, err := svc.BeginRegistration(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	_, err = svc.BeginRegistration(t.Context(), "ryan", "Ryan")

	assert.NoError(t, err)
}

// The other half of the same bug: a username stuck with no credential
// could never log in either, and the error surfaced as an opaque 500
// rather than the "no account" 404 a genuinely unregistered username
// gets — indistinguishable from a server bug to whoever hit it.
func TestBeginLogin_AbandonedRegistration_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)

	_, err := svc.BeginRegistration(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	_, err = svc.BeginLogin(t.Context(), "ryan")

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestBeginRegistration_FirstUser_Succeeds(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	_, err := svc.BeginRegistration(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	_, err = store.GetUserByUsername(t.Context(), "ryan")
	assert.NoError(t, err)
}

// An instance has one owner. Once any user holds a passkey, registration is
// closed whatever username comes in, and nothing is created.
func TestBeginRegistration_AfterAUserHoldsAPasskey_IsClosed(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	_, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	for _, username := range []string{"alex", "ryan"} {
		_, err = svc.BeginRegistration(t.Context(), username, "Anyone")

		require.ErrorIs(t, err, auth.ErrRegistrationClosed, username)
	}

	_, getErr := store.GetUserByUsername(t.Context(), "alex")
	assert.ErrorIs(t, getErr, auth.ErrNotFound, "a refused registration must not create an account")
}

// After the operator clears the passkeys, the user row is all that is left of
// the owner, and the saved settings hang off its id. Registering again must
// attach to that row, not delete it and make a new one, or the settings and
// the webhook token are orphaned.
func TestBeginRegistration_PasskeyLessUser_KeepsTheRowAndItsID(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	owner, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)

	for _, username := range []string{"ryan", "ryan-new"} {
		_, err = svc.BeginRegistration(t.Context(), username, "Ryan")
		require.NoError(t, err, username)
	}

	got, err := store.GetUserByUsername(t.Context(), "ryan")
	require.NoError(t, err, "no second row appeared, and the username holds until a ceremony wins")
	assert.Equal(t, owner.ID, got.ID, "the row, and so its id, must survive")
}

// Rows from earlier attempts under other usernames pile up while no passkey
// exists. Once their ceremony has expired nothing can finish them, so a new
// attempt clears them. A recent one may still be mid-ceremony and stays.
func TestBeginRegistration_ClearsExpiredAbandonedRowsOfOtherUsernames(t *testing.T) {
	t.Parallel()
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "auth.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))
	wa, err := webauthn.New(&webauthn.Config{RPID: "localhost", RPDisplayName: "Test", RPOrigins: []string{"http://localhost"}})
	require.NoError(t, err)
	svc := auth.NewService(wa, store)
	for _, name := range []string{"owner", "stale", "recent"} {
		_, err = store.CreateUser(t.Context(), name, name)
		require.NoError(t, err)
	}
	_, err = db.ExecContext(t.Context(), `UPDATE users SET created_at = ? WHERE username = 'owner'`, time.Now().UTC().Add(-2*time.Hour))
	require.NoError(t, err)
	_, err = db.ExecContext(t.Context(), `UPDATE users SET created_at = ? WHERE username = 'stale'`, time.Now().UTC().Add(-time.Hour))
	require.NoError(t, err)

	_, err = svc.BeginRegistration(t.Context(), "third", "Third")
	require.NoError(t, err)

	_, err = store.GetUserByUsername(t.Context(), "owner")
	require.NoError(t, err, "the oldest row is the owner's and is claimed, not dropped")
	_, err = store.GetUserByUsername(t.Context(), "stale")
	require.ErrorIs(t, err, auth.ErrNotFound)
	_, err = store.GetUserByUsername(t.Context(), "recent")
	require.NoError(t, err)
}

// newServiceWithASurvivingSecondUser is a database the single-user cleanup left
// two users in: the owner, and a newer row also holding a passkey (a registration
// that finished after the cleanup ran).
func newServiceWithASurvivingSecondUser(t *testing.T) (*auth.Service, *auth.Store) {
	t.Helper()
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "auth.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))
	_, err = store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	time.Sleep(2 * time.Millisecond)
	_, err = store.CreateUser(t.Context(), "sam", "Sam")
	require.NoError(t, err)
	_, err = db.ExecContext(t.Context(), `UPDATE users SET credentials_json = '[{"id":"AQID"}]'`)
	require.NoError(t, err)

	wa, err := webauthn.New(&webauthn.Config{RPID: "localhost", RPDisplayName: "Forge Board Test", RPOrigins: []string{"http://localhost"}})
	require.NoError(t, err)

	return auth.NewService(wa, store), store
}

func TestBeginLogin_ASurvivingNonOwnerUser_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	svc, _ := newServiceWithASurvivingSecondUser(t)

	_, err := svc.BeginLogin(t.Context(), "sam")

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestFinishLogin_ASurvivingNonOwnerUser_NeverMintsAnOwnerSession(t *testing.T) {
	t.Parallel()
	svc, store := newServiceWithASurvivingSecondUser(t)
	require.NoError(t, store.SaveCeremony(t.Context(), "sam", "login", webauthn.SessionData{}, time.Minute))

	u, err := svc.FinishLogin(t.Context(), "sam", httptest.NewRequest(http.MethodPost, "/", nil))

	assert.Nil(t, u)
	assert.ErrorIs(t, err, auth.ErrNotFound, "the check runs before the assertion is read")
}

func TestClaimUnregisteredUser_PicksTheRowOwnerOrderPicks(t *testing.T) {
	t.Parallel()
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "auth.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))
	// Same created_at, so only the tie-break decides; the later row has the smaller id.
	for _, stmt := range []string{
		`INSERT INTO users (id, username, display_name, credentials_json, created_at) VALUES ('enp6', 'first', 'F', '[]', '2026-01-01 00:00:00')`,
		`INSERT INTO users (id, username, display_name, credentials_json, created_at) VALUES ('YWFh', 'second', 'S', '[]', '2026-01-01 00:00:00')`,
	} {
		_, err := db.ExecContext(t.Context(), stmt)
		require.NoError(t, err)
	}
	owner, err := store.Owner(t.Context())
	require.NoError(t, err)

	claimed, err := store.ClaimUnregisteredUser(t.Context(), "new", "New", time.Now().Add(-time.Hour))

	require.NoError(t, err)
	assert.Equal(t, owner.ID, claimed.ID, "a registration must attach to the user the store calls the owner")
}
