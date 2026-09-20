package auth_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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

	_, err := svc.BeginRegistration(t.Context(), "ryan", "Ryan", "")
	require.NoError(t, err)

	_, err = svc.BeginRegistration(t.Context(), "ryan", "Ryan", "")

	assert.NoError(t, err)
}

// No ADMIN_USERNAME env var to get right or forget — the first username
// to actually complete registration becomes admin.
func TestBeginRegistration_FirstUser_BecomesAdmin(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	_, err := svc.BeginRegistration(t.Context(), "ryan", "Ryan", "")
	require.NoError(t, err)

	u, err := store.GetUserByUsername(t.Context(), "ryan")
	require.NoError(t, err)
	assert.True(t, u.IsAdmin)
}

func TestBeginRegistration_SecondUser_IsNotAdmin(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	admin, err := store.CreateUser(t.Context(), "ryan", "Ryan", true)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), admin.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
	token, _, err := store.CreateInvite(t.Context(), "alex", "Alex", admin.ID, time.Hour)
	require.NoError(t, err)

	_, err = svc.BeginRegistration(t.Context(), "alex", "Alex", token)
	require.NoError(t, err)

	alex, err := store.GetUserByUsername(t.Context(), "alex")
	require.NoError(t, err)
	assert.False(t, alex.IsAdmin)
}

func TestBeginRegistration_CompletedRegistration_IsRefused(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	u, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	_, err = svc.BeginRegistration(t.Context(), "ryan", "Ryan", "")

	assert.ErrorIs(t, err, auth.ErrAlreadyRegistered)
}

// The other half of the same bug: a username stuck with no credential
// could never log in either, and the error surfaced as an opaque 500
// rather than the "no account" 404 a genuinely unregistered username
// gets — indistinguishable from a server bug to whoever hit it.
func TestBeginLogin_AbandonedRegistration_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)

	_, err := svc.BeginRegistration(t.Context(), "ryan", "Ryan", "")
	require.NoError(t, err)

	_, err = svc.BeginLogin(t.Context(), "ryan")

	assert.ErrorIs(t, err, auth.ErrNotFound)
}

func TestBeginRegistration_SecondUser_WithoutInvite_IsRejected(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	admin, err := store.CreateUser(t.Context(), "ryan", "Ryan", true)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), admin.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	_, err = svc.BeginRegistration(t.Context(), "alex", "Alex", "")

	require.ErrorIs(t, err, auth.ErrInvalidInvite)

	_, getErr := store.GetUserByUsername(t.Context(), "alex")
	assert.ErrorIs(t, getErr, auth.ErrNotFound, "a rejected registration must not create an account")
}

func TestBeginRegistration_SecondUser_WithValidInvite_Succeeds(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	admin, err := store.CreateUser(t.Context(), "ryan", "Ryan", true)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), admin.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
	token, _, err := store.CreateInvite(t.Context(), "alex", "Invited Alex", admin.ID, time.Hour)
	require.NoError(t, err)

	_, err = svc.BeginRegistration(t.Context(), "alex", "whatever the caller sent", token)
	require.NoError(t, err)

	alex, err := store.GetUserByUsername(t.Context(), "alex")
	require.NoError(t, err)
	assert.Equal(t, "Invited Alex", alex.DisplayName, "the invite's own displayName wins over whatever the caller passed")
}

func TestBeginRegistration_WithExpiredInvite_IsRejected(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	admin, err := store.CreateUser(t.Context(), "ryan", "Ryan", true)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), admin.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
	token, _, err := store.CreateInvite(t.Context(), "alex", "Alex", admin.ID, -time.Minute)
	require.NoError(t, err)

	_, err = svc.BeginRegistration(t.Context(), "alex", "Alex", token)

	assert.ErrorIs(t, err, auth.ErrInvalidInvite)
}

func TestBeginRegistration_WithConsumedInvite_IsRejected(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	admin, err := store.CreateUser(t.Context(), "ryan", "Ryan", true)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), admin.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
	token, _, err := store.CreateInvite(t.Context(), "alex", "Alex", admin.ID, time.Hour)
	require.NoError(t, err)

	_, err = svc.BeginRegistration(t.Context(), "alex", "Alex", token)
	require.NoError(t, err)

	_, err = svc.BeginRegistration(t.Context(), "alex", "Alex", token)

	assert.ErrorIs(t, err, auth.ErrInvalidInvite)
}

func TestBeginRegistration_WithInviteForDifferentUsername_IsRejected(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	admin, err := store.CreateUser(t.Context(), "ryan", "Ryan", true)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), admin.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
	token, _, err := store.CreateInvite(t.Context(), "alex", "Alex", admin.ID, time.Hour)
	require.NoError(t, err)

	_, err = svc.BeginRegistration(t.Context(), "someone-else", "Someone Else", token)

	assert.ErrorIs(t, err, auth.ErrInvalidInvite)
}

func TestCreateInvite_NonAdminRequester_IsRejected(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	nonAdmin, err := store.CreateUser(t.Context(), "ryan", "Ryan", false)
	require.NoError(t, err)

	_, _, err = svc.CreateInvite(t.Context(), nonAdmin, "alex", "Alex")

	assert.ErrorIs(t, err, auth.ErrNotAdmin)
}

func TestCreateInvite_AlreadyRegisteredUsername_IsRejected(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	admin, err := store.CreateUser(t.Context(), "ryan", "Ryan", true)
	require.NoError(t, err)
	registered, err := store.CreateUser(t.Context(), "alex", "Alex", false)
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), registered.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	_, _, err = svc.CreateInvite(t.Context(), admin, "alex", "Alex")

	assert.ErrorIs(t, err, auth.ErrAlreadyRegistered)
}

func TestCreateInvite_Admin_Succeeds(t *testing.T) {
	t.Parallel()
	svc, store := newTestService(t)

	admin, err := store.CreateUser(t.Context(), "ryan", "Ryan", true)
	require.NoError(t, err)

	token, invite, err := svc.CreateInvite(t.Context(), admin, "alex", "Alex")
	require.NoError(t, err)
	assert.NotEmpty(t, token)
	assert.Equal(t, "alex", invite.Username)
	assert.Equal(t, "Alex", invite.DisplayName)

	consumed, err := store.ConsumeInviteIfValid(t.Context(), token, "alex")
	require.NoError(t, err)
	assert.Equal(t, "Alex", consumed.DisplayName)
}
