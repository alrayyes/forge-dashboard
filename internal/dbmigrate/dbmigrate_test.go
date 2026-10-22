package dbmigrate_test

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/dbmigrate"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func open(t *testing.T) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "app.db")
	db, err := sql.Open("sqlite", dbdsn.For(path))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	return db, path
}

func exec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	_, err := db.ExecContext(context.Background(), query, args...)
	require.NoError(t, err)
}

func count(t *testing.T, db *sql.DB, query string) int {
	t.Helper()
	var n int
	require.NoError(t, db.QueryRowContext(context.Background(), query).Scan(&n))

	return n
}

func version(t *testing.T, db *sql.DB) int {
	t.Helper()

	if count(t, db, `SELECT count(*) FROM sqlite_master WHERE name = 'schema_version'`) == 0 {
		return 0 // nothing was stamped
	}

	return count(t, db, `SELECT version FROM schema_version`)
}

// rebuild is a realistic step: it rebuilds a table whose primary key includes
// a column being dropped, the way SQLite's documented procedure does.
var rebuild = dbmigrate.Step{
	Name: "drop user_id from notes",
	Run: func(ctx context.Context, tx dbmigrate.Tx) error {
		for _, q := range []string{
			`CREATE TABLE notes_new (title TEXT NOT NULL PRIMARY KEY, body TEXT NOT NULL)`,
			`INSERT INTO notes_new (title, body) SELECT title, body FROM notes`,
			`DROP TABLE notes`,
			`ALTER TABLE notes_new RENAME TO notes`,
		} {
			if _, err := tx.ExecContext(ctx, q); err != nil {
				return err //nolint:wrapcheck // test step
			}
		}

		return nil
	},
}

func seedOld(t *testing.T, db *sql.DB) {
	t.Helper()
	exec(t, db, `CREATE TABLE notes (user_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (user_id, title))`)
	for _, title := range []string{"a", "b", "c"} {
		exec(t, db, `INSERT INTO notes (user_id, title, body) VALUES ('u1', ?1, 'body-' || ?1)`, title)
	}
}

func hasUserID(t *testing.T, db *sql.DB) int {
	t.Helper()

	return count(t, db, `SELECT count(*) FROM pragma_table_info('notes') WHERE name = 'user_id'`)
}

func backups(t *testing.T, path string) []string {
	t.Helper()
	found, err := filepath.Glob(path + ".before-migration-*")
	require.NoError(t, err)

	return found
}

func TestRun_KeepsEveryRowAndStampsTheVersion(t *testing.T) {
	db, path := open(t)
	seedOld(t, db)

	res, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{rebuild}, quiet)
	require.NoError(t, err)

	assert.Equal(t, 1, res.Applied)
	assert.Equal(t, 1, version(t, db))
	assert.Equal(t, 3, count(t, db, `SELECT count(*) FROM notes`))
	assert.Equal(t, 1, count(t, db, `SELECT count(*) FROM notes WHERE title = 'b' AND body = 'body-b'`))
	assert.Equal(t, 0, hasUserID(t, db))
}

func TestRun_SecondRunChangesNothing(t *testing.T) {
	db, path := open(t)
	seedOld(t, db)
	steps := []dbmigrate.Step{rebuild}
	_, err := dbmigrate.Run(context.Background(), db, path, steps, quiet)
	require.NoError(t, err)

	res, err := dbmigrate.Run(context.Background(), db, path, steps, quiet)
	require.NoError(t, err)

	assert.Equal(t, 0, res.Applied)
	assert.Empty(t, res.BackupPath)
	assert.Equal(t, 3, count(t, db, `SELECT count(*) FROM notes`))
	assert.Len(t, backups(t, path), 1, "only the first run takes a backup")
}

func TestRun_BacksUpBeforeTheFirstStepWithMode0600(t *testing.T) {
	db, path := open(t)
	seedOld(t, db)

	res, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{rebuild}, quiet)
	require.NoError(t, err)

	require.NotEmpty(t, res.BackupPath)
	info, err := os.Stat(res.BackupPath)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())

	backup, err := sql.Open("sqlite", res.BackupPath)
	require.NoError(t, err)
	defer func() { _ = backup.Close() }()
	assert.Equal(t, 1, hasUserID(t, backup), "the backup holds the old shape")
	assert.Equal(t, 3, count(t, backup, `SELECT count(*) FROM notes`))
}

func TestRun_AFailingStepLeavesEveryTableAndTheVersionAlone(t *testing.T) {
	db, path := open(t)
	seedOld(t, db)
	boom := errors.New("injected")
	failing := dbmigrate.Step{
		Name: "fails after rebuilding",
		Run: func(ctx context.Context, tx dbmigrate.Tx) error {
			if err := rebuild.Run(ctx, tx); err != nil {
				return err //nolint:wrapcheck // test step
			}

			return boom
		},
	}

	_, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{failing}, quiet)

	require.ErrorIs(t, err, boom)
	assert.Equal(t, 0, version(t, db))
	assert.Equal(t, 1, hasUserID(t, db))
	assert.Equal(t, 3, count(t, db, `SELECT count(*) FROM notes`))
	assert.Equal(t, 0, count(t, db, `SELECT count(*) FROM sqlite_master WHERE name = 'notes_new'`))
}

func TestRun_EarlierStepsStayWhenALaterOneFails(t *testing.T) {
	db, path := open(t)
	seedOld(t, db)
	failing := dbmigrate.Step{Name: "second", Run: func(context.Context, dbmigrate.Tx) error { return errors.New("no") }}

	_, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{rebuild, failing}, quiet)

	require.Error(t, err)
	assert.Equal(t, 1, version(t, db), "each step commits on its own")
	assert.Equal(t, 0, hasUserID(t, db))
}

func TestRun_AFreshDatabaseIsStampedWithoutRunningAStep(t *testing.T) {
	db, path := open(t)
	ran := false
	step := dbmigrate.Step{Name: "x", Run: func(context.Context, dbmigrate.Tx) error {
		ran = true

		return nil
	}}

	res, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{step}, quiet)
	require.NoError(t, err)

	assert.False(t, ran)
	assert.Equal(t, 0, res.Applied)
	assert.Empty(t, res.BackupPath)
	assert.Equal(t, 1, version(t, db))
	assert.Empty(t, backups(t, path))
}

func TestRun_RefusesWhenTheDatabaseIsNewerThanTheBinary(t *testing.T) {
	db, path := open(t)
	_, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{rebuild, rebuild}, quiet)
	require.NoError(t, err)

	_, err = dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{rebuild}, quiet)

	require.Error(t, err)
	require.ErrorIs(t, err, dbmigrate.ErrNewerDatabase)
}

func TestRun_ADanglingForeignKeyRollsTheStepBack(t *testing.T) {
	db, path := open(t)
	exec(t, db, `CREATE TABLE parent (id INTEGER PRIMARY KEY)`)
	exec(t, db, `CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))`)
	exec(t, db, `INSERT INTO parent (id) VALUES (1)`)
	exec(t, db, `INSERT INTO child (id, parent_id) VALUES (1, 1)`)
	orphan := dbmigrate.Step{Name: "orphans the child", Run: func(ctx context.Context, tx dbmigrate.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM parent`)

		return err //nolint:wrapcheck // test step
	}}

	_, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{orphan}, quiet)

	require.Error(t, err)
	require.ErrorIs(t, err, dbmigrate.ErrDanglingForeignKey)
	assert.Equal(t, 0, version(t, db))
	assert.Equal(t, 1, count(t, db, `SELECT count(*) FROM parent`))
}

func TestRun_LeavesForeignKeysAsItFoundThem(t *testing.T) {
	db, path := open(t)
	db.SetMaxOpenConns(1)
	exec(t, db, `PRAGMA foreign_keys = ON`)
	seedOld(t, db)

	_, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{rebuild}, quiet)
	require.NoError(t, err)

	assert.Equal(t, 1, count(t, db, `PRAGMA foreign_keys`))
}

func TestRun_AStepHoldsTheWriteLockFromItsFirstStatement(t *testing.T) {
	db, path := open(t)
	seedOld(t, db)
	other, err := sql.Open("sqlite", path) // no busy timeout: a held lock fails at once
	require.NoError(t, err)
	t.Cleanup(func() { _ = other.Close() })
	var writeErr error
	readOnly := dbmigrate.Step{Name: "reads first", Run: func(ctx context.Context, tx dbmigrate.Tx) error {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM notes`).Scan(&n); err != nil {
			return err //nolint:wrapcheck // test step
		}
		_, writeErr = other.ExecContext(ctx, `INSERT INTO notes (user_id, title, body) VALUES ('u', 'x', 'y')`)

		return nil
	}}

	_, err = dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{readOnly}, quiet)

	require.NoError(t, err)
	require.Error(t, writeErr, "another connection must not get a write in once the step has begun")
}

func TestRun_TheBackupIsOfTheDatabaseAsItWas_NotOneThatAlreadyHoldsAVersionRow(t *testing.T) {
	db, path := open(t)
	seedOld(t, db)

	res, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{rebuild}, quiet)
	require.NoError(t, err)

	backup, err := sql.Open("sqlite", res.BackupPath)
	require.NoError(t, err)
	t.Cleanup(func() { _ = backup.Close() })
	assert.Equal(t, 0, count(t, backup, `SELECT count(*) FROM sqlite_master WHERE name = 'schema_version'`))
}

func TestRun_OnlyTheTablesAStepNamesAreCheckedForDanglingKeys(t *testing.T) {
	db, path := open(t)
	db.SetMaxOpenConns(1)
	exec(t, db, `PRAGMA foreign_keys = OFF`)
	exec(t, db, `CREATE TABLE parent (id INTEGER PRIMARY KEY)`)
	exec(t, db, `CREATE TABLE stale (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))`)
	exec(t, db, `INSERT INTO stale (id, parent_id) VALUES (1, 99)`) // already dangling before the step
	exec(t, db, `CREATE TABLE mine (id INTEGER PRIMARY KEY)`)
	step := dbmigrate.Step{Name: "touches mine", Tables: []string{"mine"}, Run: func(ctx context.Context, tx dbmigrate.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO mine (id) VALUES (1)`)

		return err //nolint:wrapcheck // test step
	}}

	_, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{step}, quiet)

	require.NoError(t, err, "a dangling key in a table the step never touched is not the step's doing")
	assert.Equal(t, 1, version(t, db))
}

func TestRun_ADanglingKeyInANamedTableRollsTheStepBack(t *testing.T) {
	db, path := open(t)
	db.SetMaxOpenConns(1)
	exec(t, db, `PRAGMA foreign_keys = OFF`)
	exec(t, db, `CREATE TABLE parent (id INTEGER PRIMARY KEY)`)
	exec(t, db, `CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))`)
	step := dbmigrate.Step{Name: "dangles", Tables: []string{"child"}, Run: func(ctx context.Context, tx dbmigrate.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO child (id, parent_id) VALUES (1, 7)`)

		return err //nolint:wrapcheck // test step
	}}

	_, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{step}, quiet)

	require.ErrorIs(t, err, dbmigrate.ErrDanglingForeignKey)
	assert.Equal(t, 0, count(t, db, `SELECT count(*) FROM child`))
}

func TestRun_AStepThatWillRefuseTakesNoBackupAndWritesNothing(t *testing.T) {
	db, path := open(t)
	seedOld(t, db)
	refuse := errors.New("refused up front")
	ran := false
	step := dbmigrate.Step{
		Name:      "refuses",
		Preflight: func(context.Context, dbmigrate.Tx) error { return refuse },
		Run: func(context.Context, dbmigrate.Tx) error {
			ran = true

			return nil
		},
	}

	for range 3 { // a refused start repeated must not pile up copies of the database
		_, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{step}, quiet)
		require.ErrorIs(t, err, refuse)
	}

	assert.False(t, ran)
	assert.Empty(t, backups(t, path))
	assert.Equal(t, 0, count(t, db, `SELECT count(*) FROM sqlite_master WHERE name = 'schema_version'`))
}

func TestRun_APassingPreflightLetsTheBackupAndTheStepRun(t *testing.T) {
	db, path := open(t)
	seedOld(t, db)
	step := rebuild
	step.Preflight = func(context.Context, dbmigrate.Tx) error { return nil }

	res, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{step}, quiet)

	require.NoError(t, err)
	assert.NotEmpty(t, res.BackupPath)
	assert.Equal(t, 1, version(t, db))
}

func TestRun_AFailedRollbackIsReportedAlongsideTheStepError(t *testing.T) {
	db, path := open(t)
	seedOld(t, db)
	boom := errors.New("injected")
	// A step that ends the transaction itself leaves nothing for ROLLBACK to undo,
	// so the rollback fails.
	step := dbmigrate.Step{Name: "commits early", Run: func(ctx context.Context, tx dbmigrate.Tx) error {
		if _, err := tx.ExecContext(ctx, `COMMIT`); err != nil {
			return err //nolint:wrapcheck // test step
		}

		return boom
	}}

	_, err := dbmigrate.Run(context.Background(), db, path, []dbmigrate.Step{step}, quiet)

	require.ErrorIs(t, err, boom)
	assert.ErrorContains(t, err, "rollback")
}
