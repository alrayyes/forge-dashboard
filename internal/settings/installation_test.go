package settings_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStore_Installations_NoneSaved_IsEmpty(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)

	got, err := store.Installations(t.Context())

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_SaveInstallation_ListsInTheOrderTheyWereAdded(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 900, AccountLogin: "later-id-first"}))
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 5, AccountLogin: "acme"}))

	got, err := store.Installations(t.Context())

	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, int64(900), got[0].ID)
	assert.Equal(t, int64(5), got[1].ID)
	assert.True(t, got[1].Enabled)
	assert.Equal(t, settings.InstallationConnected, got[1].Status)
}

func TestStore_SaveInstallation_SameIDTwice_KeepsOneRowInPlace(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 1, AccountLogin: "a"}))
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 2, AccountLogin: "b"}))
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 1, AccountLogin: "renamed"}))

	got, err := store.Installations(t.Context())

	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, "renamed", got[0].AccountLogin)
	assert.Equal(t, int64(1), got[0].ID)
}

func TestStore_Get_ReadsTheAppInstallationFromTheFirstEnabledRow(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{}))
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 77, AccountLogin: "acme"}))

	c, err := store.Get(t.Context())

	require.NoError(t, err)
	assert.Equal(t, int64(77), c.GitHubAppInstallationID)
}

func TestStore_Set_AnInstallationID_BecomesTheFirstRow(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 42}))

	got, err := store.Installations(t.Context())

	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, int64(42), got[0].ID)
}

func TestStore_Set_ReplacingTheInstallationID_SwapsTheFirstRowAndKeepsTheOthers(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 42}))
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 8, AccountLogin: "acme"}))
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 43}))

	got, err := store.Installations(t.Context())

	require.NoError(t, err)
	ids := make([]int64, 0, len(got))
	for _, in := range got {
		ids = append(ids, in.ID)
	}
	assert.ElementsMatch(t, []int64{8, 43}, ids)
}

func TestStore_Set_ClearingTheInstallationID_RemovesTheFirstRowOnly(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 42}))
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 8, AccountLogin: "acme"}))
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 0}))

	got, err := store.Installations(t.Context())

	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, int64(8), got[0].ID)
}

func TestMigrateInstallations_CopiesTheSavedIDInAsTheFirstRowAfterABackup(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)

	res, err := migrateAll(t, db, path)

	require.NoError(t, err)
	assert.NotEmpty(t, res.BackupPath, "the database is copied before the first step")
	assert.Equal(t, 1, scalar[int](t, db, `SELECT count(*) FROM github_app_installations`))
	assert.Equal(t, 42, scalar[int](t, db, `SELECT installation_id FROM github_app_installations`))
	assert.Equal(t, 42, scalar[int](t, db, `SELECT github_app_installation_id FROM settings`), "the saved column is left as it was")
}

func TestMigrateInstallations_ReadsStillUseTheCopiedID(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	_, err := migrateAll(t, db, path)
	require.NoError(t, err)
	cipher, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)
	store := settings.NewStore(db, cipher)
	require.NoError(t, store.Init(t.Context()))

	rows, err := store.Installations(t.Context())

	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, int64(42), rows[0].ID)
	assert.True(t, rows[0].Enabled)
}

func TestMigrateInstallations_NoSavedID_CopiesNothing(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `UPDATE user_credentials SET github_app_installation_id = 0`)

	_, err := migrateAll(t, db, path)

	require.NoError(t, err)
	assert.Zero(t, scalar[int](t, db, `SELECT count(*) FROM github_app_installations`))
}

func TestMigrateInstallations_AnAlreadyMigratedDatabase_IsNotCopiedAgain(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	_, err := migrateAll(t, db, path)
	require.NoError(t, err)

	res, err := migrateAll(t, db, path)

	require.NoError(t, err)
	assert.Zero(t, res.Applied)
	assert.Equal(t, 1, scalar[int](t, db, `SELECT count(*) FROM github_app_installations`))
}

func TestStore_Set_AnIDThatIsAlreadyALaterRow_KeepsItsAccountAndStatusAndBecomesFirst(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 100}))
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 200, AccountLogin: "acme"}))
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 200}))

	got, err := store.Installations(t.Context())

	require.NoError(t, err)
	require.NotEmpty(t, got)
	assert.Equal(t, int64(200), got[0].ID)
	assert.Equal(t, "acme", got[0].AccountLogin)
	assert.Equal(t, settings.InstallationConnected, got[0].Status)

	c, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, int64(200), c.GitHubAppInstallationID)
}

func TestStore_Set_ANewID_BecomesTheFirstRead(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 42}))
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 8, AccountLogin: "acme"}))
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 43}))

	c, err := store.Get(t.Context())

	require.NoError(t, err)
	assert.Equal(t, int64(43), c.GitHubAppInstallationID)
}

func TestMigrateInstallations_ATableThatAlreadyHasRows_KeepsThem(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `CREATE TABLE github_app_installations (
		installation_id INTEGER PRIMARY KEY, account_login TEXT NOT NULL DEFAULT '',
		enabled BOOLEAN NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'connected', position INTEGER NOT NULL)`)
	mustExec(t, db, `INSERT INTO github_app_installations VALUES (42, 'acme', 1, 'connected', 1), (7, 'other', 1, 'connected', 2)`)

	_, err := migrateAll(t, db, path)

	require.NoError(t, err)
	assert.Equal(t, 2, scalar[int](t, db, `SELECT count(*) FROM github_app_installations`))
	assert.Equal(t, "acme", scalar[string](t, db, `SELECT account_login FROM github_app_installations WHERE installation_id = 42`))
}

func TestStore_Get_ListsEveryEnabledInstallationInOrder(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{}))
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 77, AccountLogin: "acme"}))
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 5, AccountLogin: "alice"}))

	c, err := store.Get(t.Context())

	require.NoError(t, err)
	assert.Equal(t, []int64{77, 5}, c.GitHubAppInstallationIDs)
	assert.Equal(t, int64(77), c.GitHubAppInstallationID, "the single ID stays the first one")
}

func TestStore_Get_NoInstallations_ListsNone(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{}))

	c, err := store.Get(t.Context())

	require.NoError(t, err)
	assert.Empty(t, c.GitHubAppInstallationIDs)
}

func TestStore_Get_ASavedIDWithNoTableRows_IsTheOnlyListedInstallation(t *testing.T) {
	t.Parallel()

	store, db := newTokenStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 9}))
	_, err := db.ExecContext(t.Context(), `DELETE FROM github_app_installations`)
	require.NoError(t, err)

	c, err := store.Get(t.Context())

	require.NoError(t, err)
	assert.Equal(t, []int64{9}, c.GitHubAppInstallationIDs)
}
