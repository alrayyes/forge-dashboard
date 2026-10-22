package main

// Package main on purpose, like healthcheck_test.go: resetPasskeys is an
// unexported function of the program itself.

import (
	"bytes"
	"database/sql"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type resetFixture struct {
	db    *sql.DB
	store *auth.Store
	path  string
	owner *auth.User
}

func newResetFixture(t *testing.T, withPasskey bool) resetFixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), "app.db")
	db, err := sql.Open("sqlite", dbdsn.For(path))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))
	owner, err := store.CreateUser(t.Context(), "ryan", "Ryan")
	require.NoError(t, err)
	if withPasskey {
		require.NoError(t, store.AddCredential(t.Context(), owner.ID, webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
		_, err = store.CreateSession(t.Context(), owner.ID, time.Hour)
		require.NoError(t, err)
	}

	return resetFixture{db: db, store: store, path: path, owner: owner}
}

func TestResetPasskeys_OwnerStillHasPasskeys_AsksForYesAndChangesNothing(t *testing.T) {
	f := newResetFixture(t, true)
	var out bytes.Buffer

	err := resetPasskeys(t.Context(), f.db, f.path, resetOptions{}, &out, slog.Default())

	require.ErrorIs(t, err, errResetNeedsYes)
	assert.Contains(t, out.String(), "--yes")
	registered, err := f.store.HasAnyRegisteredUser(t.Context())
	require.NoError(t, err)
	assert.True(t, registered)
	backups, _ := filepath.Glob(f.path + ".before-reset-passkeys-*")
	assert.Empty(t, backups, "nothing was changed, so nothing is backed up")
}

func TestResetPasskeys_WithYes_BacksUpClearsAndKeepsTheOwnersRow(t *testing.T) {
	f := newResetFixture(t, true)
	var out bytes.Buffer

	err := resetPasskeys(t.Context(), f.db, f.path, resetOptions{Yes: true}, &out, slog.Default())

	require.NoError(t, err)
	backups, err := filepath.Glob(f.path + ".before-reset-passkeys-*")
	require.NoError(t, err)
	assert.Len(t, backups, 1)
	registered, err := f.store.HasAnyRegisteredUser(t.Context())
	require.NoError(t, err)
	assert.False(t, registered, "registration is open again")
	owner, err := f.store.Owner(t.Context())
	require.NoError(t, err)
	assert.Equal(t, f.owner.ID, owner.ID)
	assert.Contains(t, out.String(), "Registration is open")
}

func TestResetPasskeys_NoPasskeyToClear_SaysSoAndSucceedsWithoutYes(t *testing.T) {
	f := newResetFixture(t, false)
	var out bytes.Buffer

	err := resetPasskeys(t.Context(), f.db, f.path, resetOptions{}, &out, slog.Default())

	require.NoError(t, err)
	assert.Contains(t, out.String(), "already open")
}

func TestResetPasskeys_NoUserAtAll_SaysRegistrationIsOpen(t *testing.T) {
	f := newResetFixture(t, false)
	_, err := f.db.ExecContext(t.Context(), `DELETE FROM users`)
	require.NoError(t, err)
	var out bytes.Buffer

	err = resetPasskeys(t.Context(), f.db, f.path, resetOptions{}, &out, slog.Default())

	require.NoError(t, err)
	assert.Contains(t, out.String(), "already open")
}

func TestParseResetOptions_ReadsYesAndTokens(t *testing.T) {
	opts, err := parseResetOptions([]string{"--yes", "--tokens"})

	require.NoError(t, err)
	assert.Equal(t, resetOptions{Yes: true, Tokens: true}, opts)
}

func TestParseResetOptions_UnknownFlag_Fails(t *testing.T) {
	_, err := parseResetOptions([]string{"--nope"})

	assert.Error(t, err)
}
