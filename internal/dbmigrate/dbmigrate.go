// Package dbmigrate runs ordered, one-way schema steps against the SQLite
// database. A one-row schema_version table records how many steps have been
// applied; each pending step runs in its own transaction, so a failure leaves
// the database at the last step that completed. Before the first pending step
// on a database that holds data, the database is copied aside.
package dbmigrate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"
)

// ErrNewerDatabase is returned when the database was migrated by a newer release.
var ErrNewerDatabase = errors.New("database is newer than this release")

// ErrDanglingForeignKey is returned when a step leaves a row pointing at nothing.
var ErrDanglingForeignKey = errors.New("foreign key check failed: a row points at nothing")

// Tx is what a step runs its statements through. It is the open transaction
// the step commits in; a step must not commit or roll it back itself.
type Tx interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Step is one schema change.
type Step struct {
	Name string
	Run  func(ctx context.Context, tx Tx) error
}

// Result says what Run did.
type Result struct {
	// Applied is how many steps ran this start.
	Applied int
	// BackupPath is the copy taken before the first step, empty when none was needed.
	BackupPath string
}

// Run brings the database up to len(steps). A database with no tables at all is
// fresh: it is stamped as current without running anything, because the stores
// create their tables in the newest shape. A database stamped with more steps
// than this binary knows is refused, since an older binary must not guess at a
// newer schema.
func Run(ctx context.Context, db *sql.DB, dbPath string, steps []Step, log *slog.Logger) (Result, error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("migrate: take a connection: %w", err)
	}
	defer func() { _ = conn.Close() }()

	current, fresh, err := readVersion(ctx, conn)
	if err != nil {
		return Result{}, err
	}
	if fresh {
		if err := setVersion(ctx, conn, len(steps)); err != nil {
			return Result{}, err
		}
		log.Info("migrate: new database stamped", slog.Int("version", len(steps)))

		return Result{}, nil
	}
	if current > len(steps) {
		return Result{}, fmt.Errorf("migrate: %w: schema version %d, this release knows %d; run the newer release or restore a backup", ErrNewerDatabase, current, len(steps))
	}
	if current == len(steps) {
		return Result{}, nil
	}

	var res Result
	res.BackupPath, err = backUp(ctx, conn, dbPath)
	if err != nil {
		return Result{}, err
	}

	restore, err := suspendForeignKeys(ctx, conn)
	if err != nil {
		return Result{}, err
	}
	defer restore()

	for i := current; i < len(steps); i++ {
		if err := apply(ctx, conn, i+1, steps[i]); err != nil {
			return res, err
		}
		res.Applied++
		log.Info("migrate: step applied", slog.String("step", steps[i].Name), slog.Int("version", i+1))
	}

	return res, nil
}

// readVersion returns the stored version. fresh is true when the database has
// no tables, so there is nothing to migrate.
func readVersion(ctx context.Context, conn *sql.Conn) (version int, fresh bool, err error) {
	var tables int
	if err := conn.QueryRowContext(ctx,
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
	).Scan(&tables); err != nil {
		return 0, false, fmt.Errorf("migrate: look for tables: %w", err)
	}
	if tables == 0 {
		return 0, true, nil
	}
	if _, err := conn.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`); err != nil {
		return 0, false, fmt.Errorf("migrate: create schema_version: %w", err)
	}
	err = conn.QueryRowContext(ctx, `SELECT version FROM schema_version`).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		// Tables exist but nothing was ever stamped: the database predates the runner.
		if _, err := conn.ExecContext(ctx, `INSERT INTO schema_version (version) VALUES (0)`); err != nil {
			return 0, false, fmt.Errorf("migrate: stamp schema_version: %w", err)
		}

		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("migrate: read schema_version: %w", err)
	}

	return version, false, nil
}

func setVersion(ctx context.Context, conn *sql.Conn, version int) error {
	return inTransaction(ctx, conn, "stamp", func() error { return writeVersion(ctx, conn, version) })
}

func writeVersion(ctx context.Context, tx Tx, version int) error {
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("migrate: create schema_version: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM schema_version`); err != nil {
		return fmt.Errorf("migrate: write schema_version: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_version (version) VALUES (?)`, version); err != nil {
		return fmt.Errorf("migrate: write schema_version: %w", err)
	}

	return nil
}

// apply runs one step, checks no foreign key dangles, and records the version,
// all in one transaction.
func apply(ctx context.Context, conn *sql.Conn, version int, step Step) error {
	return inTransaction(ctx, conn, step.Name, func() error {
		if err := step.Run(ctx, conn); err != nil {
			return fmt.Errorf("migrate: step %q: %w", step.Name, err)
		}
		if err := checkForeignKeys(ctx, conn); err != nil {
			return fmt.Errorf("migrate: step %q: %w", step.Name, err)
		}

		return writeVersion(ctx, conn, version)
	})
}

// inTransaction runs fn between BEGIN IMMEDIATE and COMMIT on conn. IMMEDIATE
// takes the write lock up front. A deferred transaction that read first and
// wrote later could fail with SQLITE_BUSY_SNAPSHOT when another connection
// wrote in between, halfway through a rebuild. database/sql's BeginTx can't
// ask for it, so the statements go through the connection directly.
func inTransaction(ctx context.Context, conn *sql.Conn, name string, fn func() error) (err error) {
	if _, err := conn.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		return fmt.Errorf("migrate: begin %q: %w", name, err)
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = conn.ExecContext(context.WithoutCancel(ctx), `ROLLBACK`)
		}
	}()

	if err := fn(); err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, `COMMIT`); err != nil {
		return fmt.Errorf("migrate: commit %q: %w", name, err)
	}
	committed = true

	return nil
}

func checkForeignKeys(ctx context.Context, tx Tx) error {
	rows, err := tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return fmt.Errorf("foreign key check: %w", err)
	}
	defer func() { _ = rows.Close() }()
	if rows.Next() {
		return ErrDanglingForeignKey
	}

	return rows.Err() //nolint:wrapcheck // the caller adds the step
}

// suspendForeignKeys switches enforcement off on this connection when it is on,
// as SQLite's table-rebuild procedure requires (DROP TABLE would otherwise
// cascade), and returns the function that puts it back. The pragma is a no-op
// inside a transaction, so it is set here, outside any.
func suspendForeignKeys(ctx context.Context, conn *sql.Conn) (func(), error) {
	var on int
	if err := conn.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&on); err != nil {
		return nil, fmt.Errorf("migrate: read foreign_keys: %w", err)
	}
	if on == 0 {
		return func() {}, nil
	}
	if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		return nil, fmt.Errorf("migrate: switch foreign_keys off: %w", err)
	}

	return func() { _, _ = conn.ExecContext(context.WithoutCancel(ctx), `PRAGMA foreign_keys = ON`) }, nil
}

// backUp copies the database next to the original. The copy holds every secret
// the database does, so the file is created 0600 before SQLite writes to it
// (VACUUM INTO accepts an existing empty file). O_EXCL makes a name clash fail
// instead of overwriting an earlier backup.
func backUp(ctx context.Context, conn *sql.Conn, dbPath string) (string, error) {
	path := fmt.Sprintf("%s.before-migration-%s", dbPath, time.Now().UTC().Format("20060102T150405.000000000Z"))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600) //nolint:gosec // path is the configured database path plus a fixed suffix
	if err != nil {
		return "", fmt.Errorf("migrate: create the backup: %w", err)
	}
	if err := f.Close(); err != nil {
		return "", fmt.Errorf("migrate: create the backup: %w", err)
	}
	if _, err := conn.ExecContext(ctx, `VACUUM INTO ?`, path); err != nil {
		_ = os.Remove(path)

		return "", fmt.Errorf("migrate: back up the database: %w", err)
	}

	return path, nil
}
