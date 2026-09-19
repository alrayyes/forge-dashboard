// Package sharing tracks which users have granted which other users
// read-only access to their aggregated dashboard. It owns no opinion
// about what a dashboard is — internal/api resolves a share into an
// actual dashboard.Manager lookup.
package sharing

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
)

// Store persists sharing relationships: ownerID has shared their
// dashboard with viewerID.
type Store struct {
	db *sql.DB
}

// NewStore wraps db. Init must be called once before any other method.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// Init creates the schema if it doesn't already exist. Safe to call every
// startup.
func (s *Store) Init(ctx context.Context) error {
	const schema = `
	CREATE TABLE IF NOT EXISTS shares (
		owner_id TEXT NOT NULL,
		viewer_id TEXT NOT NULL,
		created_at TIMESTAMP NOT NULL,
		PRIMARY KEY (owner_id, viewer_id)
	);
	`
	_, err := s.db.ExecContext(ctx, schema)
	if err != nil {
		return fmt.Errorf("sharing: create schema: %w", err)
	}

	return nil
}

// Share grants viewerID read access to ownerID's dashboard. Idempotent —
// sharing with the same viewer twice changes nothing.
func (s *Store) Share(ctx context.Context, ownerID, viewerID []byte) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO shares (owner_id, viewer_id, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT (owner_id, viewer_id) DO NOTHING`,
		encodeID(ownerID), encodeID(viewerID),
	)
	if err != nil {
		return fmt.Errorf("sharing: share: %w", err)
	}

	return nil
}

// Unshare revokes viewerID's access to ownerID's dashboard — a no-op if
// it was never granted.
func (s *Store) Unshare(ctx context.Context, ownerID, viewerID []byte) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM shares WHERE owner_id = ? AND viewer_id = ?`,
		encodeID(ownerID), encodeID(viewerID),
	)
	if err != nil {
		return fmt.Errorf("sharing: unshare: %w", err)
	}

	return nil
}

// IsSharedWith reports whether ownerID has shared their dashboard with
// viewerID.
func (s *Store) IsSharedWith(ctx context.Context, ownerID, viewerID []byte) (bool, error) {
	var exists int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM shares WHERE owner_id = ? AND viewer_id = ?`,
		encodeID(ownerID), encodeID(viewerID),
	).Scan(&exists)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return false, nil
	case err != nil:
		return false, fmt.Errorf("sharing: check share: %w", err)
	default:
		return true, nil
	}
}

// SharedWith returns every user ID ownerID has shared their dashboard
// with.
func (s *Store) SharedWith(ctx context.Context, ownerID []byte) ([][]byte, error) {
	return s.queryIDs(ctx, `SELECT viewer_id FROM shares WHERE owner_id = ?`, encodeID(ownerID))
}

// SharedWithMe returns every user ID that has shared their dashboard
// with viewerID.
func (s *Store) SharedWithMe(ctx context.Context, viewerID []byte) ([][]byte, error) {
	return s.queryIDs(ctx, `SELECT owner_id FROM shares WHERE viewer_id = ?`, encodeID(viewerID))
}

func (s *Store) queryIDs(ctx context.Context, query string, arg string) ([][]byte, error) {
	rows, err := s.db.QueryContext(ctx, query, arg)
	if err != nil {
		return nil, fmt.Errorf("sharing: query ids: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var ids [][]byte
	for rows.Next() {
		var encoded string
		if err := rows.Scan(&encoded); err != nil {
			return nil, fmt.Errorf("sharing: scan id row: %w", err)
		}
		id, err := decodeID(encoded)
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sharing: query ids: %w", err)
	}

	return ids, nil
}

// DeleteUser removes every share userID appears in, as either owner or
// viewer — used when an admin removes an account outright.
func (s *Store) DeleteUser(ctx context.Context, userID []byte) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM shares WHERE owner_id = ? OR viewer_id = ?`,
		encodeID(userID), encodeID(userID),
	)
	if err != nil {
		return fmt.Errorf("sharing: delete user: %w", err)
	}

	return nil
}

func encodeID(id []byte) string { return base64.RawURLEncoding.EncodeToString(id) }

func decodeID(s string) ([]byte, error) {
	id, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("sharing: decode stored id: %w", err)
	}

	return id, nil
}
