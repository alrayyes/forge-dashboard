package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// cacheSchemaVersion is bumped whenever a cache table below changes shape. The
// tables hold only what a forge can answer again, so a database at another
// version has them dropped and made empty rather than migrated.
const cacheSchemaVersion = 1

// defaultETagCapBytes bounds the bodies http_etags keeps; the oldest rows go first.
const defaultETagCapBytes = 20 << 20

// cacheTables are the tables a restart keeps so the first refresh doesn't pay
// for everything again. None has a user id: rows are keyed by forge, credential
// label (the one the API counters use, holding no secret) and repo.
const cacheTables = `
	CREATE TABLE IF NOT EXISTS cache_schema (version INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS http_etags (
		forge TEXT NOT NULL,
		credential TEXT NOT NULL,
		url TEXT NOT NULL,
		accept TEXT NOT NULL DEFAULT '',
		etag TEXT NOT NULL,
		body BLOB NOT NULL,
		header_json TEXT NOT NULL,
		updated_at TIMESTAMP NOT NULL,
		PRIMARY KEY (forge, credential, url, accept)
	);
	CREATE TABLE IF NOT EXISTS snapshot_cache (
		forge TEXT NOT NULL,
		credential TEXT NOT NULL,
		repo TEXT NOT NULL,
		payload_json BLOB NOT NULL,
		fetched_at TIMESTAMP NOT NULL,
		PRIMARY KEY (forge, credential, repo)
	);
	CREATE TABLE IF NOT EXISTS hook_checks (
		forge TEXT NOT NULL,
		credential TEXT NOT NULL,
		repo TEXT NOT NULL,
		has_hook BOOLEAN NOT NULL,
		events_json TEXT NOT NULL,
		refused BOOLEAN NOT NULL,
		checked_at TIMESTAMP NOT NULL,
		PRIMARY KEY (forge, credential, repo)
	);
	CREATE TABLE IF NOT EXISTS webhook_seen (
		forge TEXT NOT NULL,
		credential TEXT NOT NULL,
		repo TEXT NOT NULL,
		event_class TEXT NOT NULL,
		last_seen_at TIMESTAMP NOT NULL,
		PRIMARY KEY (forge, credential, repo, event_class)
	);
`

// initCache creates the cache tables, first emptying them when the database
// holds them at another schema version.
func (s *Store) initCache(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS cache_schema (version INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("settings: create cache schema table: %w", err)
	}

	var version int
	err := s.db.QueryRowContext(ctx, `SELECT version FROM cache_schema LIMIT 1`).Scan(&version)
	known := err == nil
	if known && version != cacheSchemaVersion {
		slog.Warn("cache tables are at another schema version, starting them empty", "found", version, "want", cacheSchemaVersion)
		for _, table := range []string{"http_etags", "snapshot_cache", "hook_checks", "webhook_seen"} {
			if _, err := s.db.ExecContext(ctx, `DROP TABLE IF EXISTS `+table); err != nil {
				return fmt.Errorf("settings: drop old cache table %s: %w", table, err)
			}
		}
	}
	if _, err := s.db.ExecContext(ctx, cacheTables); err != nil {
		return fmt.Errorf("settings: create cache tables: %w", err)
	}
	if known && version == cacheSchemaVersion {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM cache_schema`); err != nil {
		return fmt.Errorf("settings: reset cache schema version: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO cache_schema (version) VALUES (?)`, cacheSchemaVersion); err != nil {
		return fmt.Errorf("settings: record cache schema version: %w", err)
	}

	return nil
}

// SetETagCap changes the byte cap on the bodies http_etags keeps.
func (s *Store) SetETagCap(bytes int) { s.etagCap = bytes }

func (s *Store) etagCapBytes() int {
	if s.etagCap > 0 {
		return s.etagCap
	}

	return defaultETagCapBytes
}

// SaveETag stores the answer a forge gave for url, replacing any earlier one,
// then evicts the oldest rows while the bodies together pass the cap.
func (s *Store) SaveETag(ctx context.Context, forge, credential, url, accept, etag string, body []byte, header map[string][]string) error {
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return fmt.Errorf("settings: encode cached headers: %w", err)
	}
	if body == nil {
		body = []byte{}
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO http_etags (forge, credential, url, accept, etag, body, header_json, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (forge, credential, url, accept) DO UPDATE SET
		 etag = excluded.etag, body = excluded.body, header_json = excluded.header_json, updated_at = excluded.updated_at`,
		forge, credential, url, accept, etag, body, string(headerJSON), time.Now().UTC())
	if err != nil {
		return fmt.Errorf("settings: save etag: %w", err)
	}

	return s.evictETags(ctx)
}

func (s *Store) evictETags(ctx context.Context) error {
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(LENGTH(body)), 0) FROM http_etags`).Scan(&total); err != nil {
		return fmt.Errorf("settings: measure etag cache: %w", err)
	}
	limit := s.etagCapBytes()
	if total <= limit {
		return nil
	}

	rows, err := s.db.QueryContext(ctx, `SELECT rowid, LENGTH(body) FROM http_etags ORDER BY updated_at ASC, rowid ASC`)
	if err != nil {
		return fmt.Errorf("settings: list etag cache: %w", err)
	}
	var evict []int64
	for rows.Next() && total > limit {
		var id int64
		var size int
		if err := rows.Scan(&id, &size); err != nil {
			_ = rows.Close()

			return fmt.Errorf("settings: scan etag cache: %w", err)
		}
		evict = append(evict, id)
		total -= size
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return fmt.Errorf("settings: list etag cache: %w", err)
	}
	for _, id := range evict {
		if _, err := s.db.ExecContext(ctx, `DELETE FROM http_etags WHERE rowid = ?`, id); err != nil {
			return fmt.Errorf("settings: evict etag: %w", err)
		}
	}

	return nil
}

// LoadETag returns the stored answer for url, and whether there is one. A row
// whose headers can't be read counts as absent.
func (s *Store) LoadETag(ctx context.Context, forge, credential, url, accept string) (etag string, body []byte, header map[string][]string, ok bool, err error) {
	var headerJSON string
	row := s.db.QueryRowContext(ctx,
		`SELECT etag, body, header_json FROM http_etags WHERE forge = ? AND credential = ? AND url = ? AND accept = ?`,
		forge, credential, url, accept)
	if scanErr := row.Scan(&etag, &body, &headerJSON); scanErr != nil {
		if errors.Is(scanErr, sql.ErrNoRows) {
			return "", nil, nil, false, nil
		}

		return "", nil, nil, false, fmt.Errorf("settings: load etag: %w", scanErr)
	}
	if jsonErr := json.Unmarshal([]byte(headerJSON), &header); jsonErr != nil {
		slog.Warn("cached response headers unreadable, ignoring the row", "error", jsonErr)

		return "", nil, nil, false, nil
	}

	return etag, body, header, true, nil
}

// SaveSnapshotRepos replaces everything stored for forge under credential, so
// a repo that is no longer tracked drops out with the next successful refresh.
func (s *Store) SaveSnapshotRepos(ctx context.Context, forge dashboard.Forge, credential string, repos []dashboard.CachedRepo) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("settings: begin snapshot save: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `DELETE FROM snapshot_cache WHERE forge = ? AND credential = ?`, string(forge), credential); err != nil {
		return fmt.Errorf("settings: clear snapshot cache: %w", err)
	}
	for _, r := range repos {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO snapshot_cache (forge, credential, repo, payload_json, fetched_at) VALUES (?, ?, ?, ?, ?)`,
			string(forge), credential, r.Repo, r.Payload, r.FetchedAt.UTC()); err != nil {
			return fmt.Errorf("settings: save snapshot repo: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("settings: commit snapshot save: %w", err)
	}

	return nil
}

// LoadSnapshotRepos returns every repo stored for forge under credential.
func (s *Store) LoadSnapshotRepos(ctx context.Context, forge dashboard.Forge, credential string) ([]dashboard.CachedRepo, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT repo, payload_json, fetched_at FROM snapshot_cache WHERE forge = ? AND credential = ? ORDER BY repo`,
		string(forge), credential)
	if err != nil {
		return nil, fmt.Errorf("settings: load snapshot cache: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []dashboard.CachedRepo
	for rows.Next() {
		var r dashboard.CachedRepo
		if err := rows.Scan(&r.Repo, &r.Payload, &r.FetchedAt); err != nil {
			return nil, fmt.Errorf("settings: scan snapshot cache: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("settings: load snapshot cache: %w", err)
	}

	return out, nil
}

// SaveHookCheck stores what the last look at a repo's hooks found.
func (s *Store) SaveHookCheck(ctx context.Context, forge dashboard.Forge, credential string, c dashboard.HookCheck) error {
	events, err := json.Marshal(c.Events)
	if err != nil {
		return fmt.Errorf("settings: encode hook events: %w", err)
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO hook_checks (forge, credential, repo, has_hook, events_json, refused, checked_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (forge, credential, repo) DO UPDATE SET
		 has_hook = excluded.has_hook, events_json = excluded.events_json, refused = excluded.refused, checked_at = excluded.checked_at`,
		string(forge), credential, c.Repo, c.Has, string(events), c.Refused, c.CheckedAt.UTC())
	if err != nil {
		return fmt.Errorf("settings: save hook check: %w", err)
	}

	return nil
}

// LoadHookChecks returns every webhook check stored for forge under credential.
// A row whose events can't be read is skipped and logged.
func (s *Store) LoadHookChecks(ctx context.Context, forge dashboard.Forge, credential string) ([]dashboard.HookCheck, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT repo, has_hook, events_json, refused, checked_at FROM hook_checks WHERE forge = ? AND credential = ?`,
		string(forge), credential)
	if err != nil {
		return nil, fmt.Errorf("settings: load hook checks: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []dashboard.HookCheck
	for rows.Next() {
		var c dashboard.HookCheck
		var events string
		if err := rows.Scan(&c.Repo, &c.Has, &events, &c.Refused, &c.CheckedAt); err != nil {
			return nil, fmt.Errorf("settings: scan hook checks: %w", err)
		}
		if err := json.Unmarshal([]byte(events), &c.Events); err != nil {
			slog.Warn("stored webhook check unreadable, skipping it", "repo", c.Repo, "error", err)

			continue
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("settings: load hook checks: %w", err)
	}

	return out, nil
}

// SaveWebhookSeen stores when a delivery of rec.Class last arrived for rec.Repo.
func (s *Store) SaveWebhookSeen(ctx context.Context, forge dashboard.Forge, credential string, rec dashboard.SeenRecord) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO webhook_seen (forge, credential, repo, event_class, last_seen_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (forge, credential, repo, event_class) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
		string(forge), credential, rec.Repo, string(rec.Class), rec.At.UTC())
	if err != nil {
		return fmt.Errorf("settings: save webhook seen: %w", err)
	}

	return nil
}

// LoadWebhookSeen returns every delivery time stored for forge under credential.
func (s *Store) LoadWebhookSeen(ctx context.Context, forge dashboard.Forge, credential string) ([]dashboard.SeenRecord, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT repo, event_class, last_seen_at FROM webhook_seen WHERE forge = ? AND credential = ?`,
		string(forge), credential)
	if err != nil {
		return nil, fmt.Errorf("settings: load webhook seen: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []dashboard.SeenRecord
	for rows.Next() {
		var r dashboard.SeenRecord
		var class string
		if err := rows.Scan(&r.Repo, &class, &r.At); err != nil {
			return nil, fmt.Errorf("settings: scan webhook seen: %w", err)
		}
		r.Class = dashboard.EventClass(class)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("settings: load webhook seen: %w", err)
	}

	return out, nil
}
