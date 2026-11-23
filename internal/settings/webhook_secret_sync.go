package settings

import (
	"context"
	"fmt"
	"time"
)

// hookLedgerSchema holds one row: a fingerprint of the webhook secret
// the dashboard last wrote to every hook it maintains (#4683). Forges never
// return a hook's secret, so this is how a rotation is noticed. It is a hash,
// not the secret.
const hookLedgerSchema = `
	CREATE TABLE IF NOT EXISTS webhook_secret_sync (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		fingerprint TEXT NOT NULL,
		synced_at TIMESTAMP NOT NULL
	);
`

// WebhookSecretSynced returns the fingerprint last recorded, or "" before the
// first one.
func (s *Store) WebhookSecretSynced(ctx context.Context) (string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT fingerprint FROM webhook_secret_sync WHERE id = 1`)
	if err != nil {
		return "", fmt.Errorf("settings: read webhook secret fingerprint: %w", err)
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return "", fmt.Errorf("settings: read webhook secret fingerprint: %w", err)
		}

		return "", nil
	}
	var fp string
	if err := rows.Scan(&fp); err != nil {
		return "", fmt.Errorf("settings: read webhook secret fingerprint: %w", err)
	}

	return fp, nil
}

// MarkWebhookSecretSynced records fingerprint as the secret every maintained
// hook now carries.
func (s *Store) MarkWebhookSecretSynced(ctx context.Context, fingerprint string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO webhook_secret_sync (id, fingerprint, synced_at) VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint, synced_at = excluded.synced_at`,
		fingerprint, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("settings: record webhook secret fingerprint: %w", err)
	}

	return nil
}
