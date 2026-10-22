package auth_test

import (
	"testing"

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

	owner, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	require.NoError(t, store.AddCredential(t.Context(), owner.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))

	for _, username := range []string{"alex", "ryan"} {
		_, err = svc.BeginRegistration(t.Context(), username, "Anyone")

		require.ErrorIs(t, err, auth.ErrRegistrationClosed, username)
	}

	_, getErr := store.GetUserByUsername(t.Context(), "alex")
	assert.ErrorIs(t, getErr, auth.ErrNotFound, "a refused registration must not create an account")
}
