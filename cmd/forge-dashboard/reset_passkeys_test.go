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
		require.NoError(t, store.AddCredential(t.Context(), webauthn.Credential{ID: []byte("cred-1"), PublicKey: []byte("pk")}))
		_, err = store.CreateSession(t.Context(), time.Hour)
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

// oldMultiUserDatabase is a file from the release before the user id was
// dropped, still holding two users that each hold a passkey and a session.
func oldMultiUserDatabase(t *testing.T) (string, *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "app.db")
	t.Setenv("DB_PATH", path)
	db, err := sql.Open("sqlite", dbdsn.For(path))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	for _, stmt := range []string{
		`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
			credentials_json TEXT NOT NULL DEFAULT '[]', created_at TIMESTAMP NOT NULL)`,
		`CREATE TABLE ceremonies (username TEXT NOT NULL, kind TEXT NOT NULL, session_json TEXT NOT NULL,
			expires_at TIMESTAMP NOT NULL, PRIMARY KEY (username, kind))`,
		`CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
			expires_at TIMESTAMP NOT NULL, created_at TIMESTAMP NOT NULL)`,
		`CREATE TABLE credential_metadata (user_id TEXT NOT NULL, credential_id TEXT NOT NULL, label TEXT NOT NULL,
			created_at TIMESTAMP NOT NULL, PRIMARY KEY (user_id, credential_id))`,
		`INSERT INTO users VALUES ('YWFh', 'ryan', 'Ryan', '[{"id":"AQID"}]', '2026-01-01 00:00:00')`,
		`INSERT INTO users VALUES ('YmJi', 'sam', 'Sam', '[{"id":"BAUG"}]', '2026-02-01 00:00:00')`,
		`INSERT INTO sessions VALUES ('s-a', 'YWFh', '2099-01-01 00:00:00', '2026-01-01 00:00:00')`,
		`INSERT INTO sessions VALUES ('s-b', 'YmJi', '2099-01-01 00:00:00', '2026-01-01 00:00:00')`,
		`INSERT INTO credential_metadata VALUES ('YmJi', 'cred-b', 'Key', '2026-01-01 00:00:00')`,
	} {
		_, err := db.ExecContext(t.Context(), stmt)
		require.NoError(t, err)
	}

	return path, db
}

func TestRunResetPasskeys_UnmigratedMultiUserDatabase_RefusesAndDeletesNothing(t *testing.T) {
	_, db := oldMultiUserDatabase(t)

	err := runResetPasskeys([]string{"--yes"})

	require.Error(t, err, "the upgrade refuses a database the previous release has not settled")
	var sessions, labels int
	require.NoError(t, db.QueryRowContext(t.Context(), `SELECT count(*) FROM sessions`).Scan(&sessions))
	require.NoError(t, db.QueryRowContext(t.Context(), `SELECT count(*) FROM credential_metadata`).Scan(&labels))
	assert.Equal(t, 2, sessions, "no user's session may be deleted")
	assert.Equal(t, 1, labels)
}
