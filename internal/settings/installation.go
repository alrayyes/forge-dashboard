package settings

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"

	"github.com/alrayyes/forge-dashboard/internal/dbmigrate"
)

// InstallationConnected is the status of an installation whose ID GitHub
// confirmed for the connected user and that reads can use.
const InstallationConnected = "connected"

// Installation is one installation of the GitHub App: one account or org the
// owner installed it on (#4575).
type Installation struct {
	// ID is GitHub's installation ID. It is no secret: it means nothing
	// without the App's private key, so it is stored as a plain integer.
	ID int64
	// AccountLogin is the account or org the App is installed on. Empty for an
	// installation copied from the old single setting, whose account was never
	// recorded.
	AccountLogin string
	// Enabled says whether reads use this installation.
	Enabled bool
	// Status is InstallationConnected.
	Status string
}

// installationsSchema holds one row per installation. position keeps the order
// they were added in, so "the first" is stable. The migration step writes the
// same shape out for itself.
const installationsSchema = `
	CREATE TABLE IF NOT EXISTS github_app_installations (
		installation_id INTEGER PRIMARY KEY,
		account_login TEXT NOT NULL DEFAULT '',
		enabled BOOLEAN NOT NULL DEFAULT 1,
		status TEXT NOT NULL DEFAULT 'connected',
		position INTEGER NOT NULL
	);
`

// InstallationMigrationSteps are the schema steps that move the single saved
// installation ID into the installations table. They are appended after the
// settings and auth steps, since a step's position is its version number.
func InstallationMigrationSteps(log *slog.Logger) []dbmigrate.Step {
	return []dbmigrate.Step{{
		Name:   "copy the saved GitHub App installation ID into the installations table",
		Tables: []string{"github_app_installations"},
		Run: func(ctx context.Context, tx dbmigrate.Tx) error {
			return copyInstallationID(ctx, tx, log)
		},
	}}
}

func copyInstallationID(ctx context.Context, tx dbmigrate.Tx, log *slog.Logger) error {
	if _, err := tx.ExecContext(ctx, installationsSchema); err != nil {
		return fmt.Errorf("create installations table: %w", err)
	}

	// The saved column stays as it was: a rollback to the previous release
	// still finds its installation there.
	res, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO github_app_installations (installation_id, enabled, status, position)
		SELECT github_app_installation_id, 1, 'connected', 1 FROM settings WHERE github_app_installation_id != 0`)
	if err != nil {
		return fmt.Errorf("copy the installation ID: %w", err)
	}

	n, _ := res.RowsAffected()
	log.Info("migrate: installation ID copied", slog.Int64("rows", n))

	return nil
}

// Installations returns every installation in the order it was added.
func (s *Store) Installations(ctx context.Context) ([]Installation, error) {
	return listInstallations(ctx, s.db)
}

type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func listInstallations(ctx context.Context, q queryer) ([]Installation, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT installation_id, account_login, enabled, status
		FROM github_app_installations ORDER BY position, installation_id`)
	if err != nil {
		return nil, fmt.Errorf("settings: list installations: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []Installation
	for rows.Next() {
		var in Installation
		if err := rows.Scan(&in.ID, &in.AccountLogin, &in.Enabled, &in.Status); err != nil {
			return nil, fmt.Errorf("settings: read installation: %w", err)
		}
		out = append(out, in)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("settings: list installations: %w", err)
	}

	return out, nil
}

// SaveInstallation adds an installation, or updates the one with the same ID
// in place. A blank Status means InstallationConnected.
func (s *Store) SaveInstallation(ctx context.Context, in Installation) error {
	return upsertInstallation(ctx, s.db, in)
}

func upsertInstallation(ctx context.Context, q queryer, in Installation) error {
	status := in.Status
	if status == "" {
		status = InstallationConnected
	}

	_, err := q.ExecContext(ctx, `
		INSERT INTO github_app_installations (installation_id, account_login, enabled, status, position)
		VALUES (?, ?, 1, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM github_app_installations))
		ON CONFLICT (installation_id) DO UPDATE SET
			account_login = excluded.account_login, status = excluded.status`,
		in.ID, in.AccountLogin, status)
	if err != nil {
		return fmt.Errorf("settings: save installation: %w", err)
	}

	return nil
}

// enabledInstallations is the ID of every enabled row, in the order they were
// added.
func enabledInstallations(ctx context.Context, q queryer) ([]int64, error) {
	all, err := listInstallations(ctx, q)
	if err != nil {
		return nil, err
	}

	var ids []int64
	for _, in := range all {
		if in.Enabled {
			ids = append(ids, in.ID)
		}
	}

	return ids, nil
}

// firstEnabledInstallation is the ID reads use, 0 when no row is enabled.
func firstEnabledInstallation(ctx context.Context, q queryer) (int64, error) {
	var id int64
	err := q.QueryRowContext(ctx, `
		SELECT installation_id FROM github_app_installations
		WHERE enabled = 1 ORDER BY position, installation_id LIMIT 1`).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("settings: read first installation: %w", err)
	}

	return id, nil
}

// syncSavedInstallation applies the single saved installation ID to the table:
// the first row becomes id, and any other row is left alone. It runs in Set's
// transaction.
func syncSavedInstallation(ctx context.Context, q queryer, id int64) error {
	prev, err := firstEnabledInstallation(ctx, q)
	if err != nil {
		return err
	}
	if prev == id {
		return nil
	}
	if prev != 0 {
		if _, err := q.ExecContext(ctx, `DELETE FROM github_app_installations WHERE installation_id = ?`, prev); err != nil {
			return fmt.Errorf("settings: replace installation: %w", err)
		}
	}
	if id == 0 {
		return nil
	}

	return promoteInstallation(ctx, q, id)
}

// promoteInstallation makes id the first row. A row that already exists keeps
// its account and status, since the settings form knows only the ID; a new one
// is added with neither. Either way it sorts ahead of every other row, so the
// ID the form saved is the one reads use.
func promoteInstallation(ctx context.Context, q queryer, id int64) error {
	_, err := q.ExecContext(ctx, `
		INSERT INTO github_app_installations (installation_id, account_login, enabled, status, position)
		VALUES (?, '', 1, ?, (SELECT COALESCE(MIN(position), 1) - 1 FROM github_app_installations))
		ON CONFLICT (installation_id) DO UPDATE SET
			position = (SELECT COALESCE(MIN(position), 1) - 1 FROM github_app_installations)`,
		id, InstallationConnected)
	if err != nil {
		return fmt.Errorf("settings: promote installation: %w", err)
	}

	return nil
}
