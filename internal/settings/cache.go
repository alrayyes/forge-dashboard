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
const cacheSchemaVersion = 2

// defaultETagCapBytes bounds the bodies http_etags keeps; the least recently
// used rows go first.
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
		last_used_at TIMESTAMP NOT NULL,
		PRIMARY KEY (forge, credential, url, accept)
	);
	CREATE INDEX IF NOT EXISTS http_etags_last_used ON http_etags (last_used_at);
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
		return s.loadETagBytes(ctx)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM cache_schema`); err != nil {
		return fmt.Errorf("settings: reset cache schema version: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO cache_schema (version) VALUES (?)`, cacheSchemaVersion); err != nil {
		return fmt.Errorf("settings: record cache schema version: %w", err)
	}

	return s.loadETagBytes(ctx)
}

// SetETagCap changes the byte cap on the bodies http_etags keeps.
func (s *Store) SetETagCap(bytes int) {
	s.etagMu.Lock()
	defer s.etagMu.Unlock()
	s.etagCap = bytes
}

func (s *Store) etagCapBytes() int {
	if s.etagCap > 0 {
		return s.etagCap
	}

	return defaultETagCapBytes
}

// loadETagBytes totals the bodies once, so every later save and eviction can
// keep the figure up to date instead of measuring the table again.
func (s *Store) loadETagBytes(ctx context.Context) error {
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(LENGTH(body)), 0) FROM http_etags`).Scan(&total); err != nil {
		return fmt.Errorf("settings: measure etag cache: %w", err)
	}
	s.etagMu.Lock()
	defer s.etagMu.Unlock()
	s.etagBytes = total

	return nil
}

// SaveETag stores the answer a forge gave for url, replacing any earlier one,
// then evicts the least recently used rows while the bodies together pass the
// cap. A body bigger than the cap is never stored, and it drops the earlier
// answer for url, whose ETag no longer matches what the forge serves.
func (s *Store) SaveETag(ctx context.Context, forge, credential, url, accept, etag string, body []byte, header map[string][]string) error {
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return fmt.Errorf("settings: encode cached headers: %w", err)
	}
	if body == nil {
		body = []byte{}
	}

	s.etagMu.Lock()
	defer s.etagMu.Unlock()

	var old sql.NullInt64
	err = s.db.QueryRowContext(ctx,
		`SELECT LENGTH(body) FROM http_etags WHERE forge = ? AND credential = ? AND url = ? AND accept = ?`,
		forge, credential, url, accept).Scan(&old)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("settings: look up etag: %w", err)
	}

	if len(body) > s.etagCapBytes() {
		if !old.Valid {
			return nil
		}
		if _, err := s.db.ExecContext(ctx,
			`DELETE FROM http_etags WHERE forge = ? AND credential = ? AND url = ? AND accept = ?`,
			forge, credential, url, accept); err != nil {
			return fmt.Errorf("settings: drop outdated etag: %w", err)
		}
		s.etagBytes -= int(old.Int64)

		return nil
	}

	now := time.Now().UTC()
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO http_etags (forge, credential, url, accept, etag, body, header_json, updated_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (forge, credential, url, accept) DO UPDATE SET
		 etag = excluded.etag, body = excluded.body, header_json = excluded.header_json,
		 updated_at = excluded.updated_at, last_used_at = excluded.last_used_at`,
		forge, credential, url, accept, etag, body, string(headerJSON), now, now)
	if err != nil {
		return fmt.Errorf("settings: save etag: %w", err)
	}
	s.etagBytes += len(body) - int(old.Int64)

	return s.evictETags(ctx)
}

// TouchETag marks the answer stored for url as just used, so it is the last
// to be evicted. A url with no stored answer is left alone.
func (s *Store) TouchETag(ctx context.Context, forge, credential, url, accept string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE http_etags SET last_used_at = ? WHERE forge = ? AND credential = ? AND url = ? AND accept = ?`,
		time.Now().UTC(), forge, credential, url, accept)
	if err != nil {
		return fmt.Errorf("settings: touch etag: %w", err)
	}

	return nil
}

// evictETags drops the least recently used rows until the tracked total is
// within the cap. The caller holds etagMu.
func (s *Store) evictETags(ctx context.Context) error {
	limit := s.etagCapBytes()
	if s.etagBytes <= limit {
		return nil
	}

	rows, err := s.db.QueryContext(ctx, `SELECT rowid, LENGTH(body) FROM http_etags ORDER BY last_used_at ASC, rowid ASC`)
	if err != nil {
		return fmt.Errorf("settings: list etag cache: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var ids []int64
	total := s.etagBytes
	for rows.Next() && total > limit {
		var id int64
		var size int
		if err := rows.Scan(&id, &size); err != nil {
			return fmt.Errorf("settings: scan etag cache: %w", err)
		}
		ids = append(ids, id)
		total -= size
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("settings: list etag cache: %w", err)
	}
	_ = rows.Close()

	for _, id := range ids {
		if _, err := s.db.ExecContext(ctx, `DELETE FROM http_etags WHERE rowid = ?`, id); err != nil {
			return fmt.Errorf("settings: evict etag: %w", err)
		}
	}
	s.etagBytes = total

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

// SaveSnapshotChanges writes the repos in changed, replacing a stored row of
// the same name, and deletes the ones named in removed. Every other row stored
// for forge under credential is left alone, so an unchanged repo costs no write.
func (s *Store) SaveSnapshotChanges(ctx context.Context, forge dashboard.Forge, credential string, changed []dashboard.CachedRepo, removed []string) error {
	if len(changed) == 0 && len(removed) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("settings: begin snapshot save: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for _, repo := range removed {
		if _, err := tx.ExecContext(ctx, `DELETE FROM snapshot_cache WHERE forge = ? AND credential = ? AND repo = ?`, string(forge), credential, repo); err != nil {
			return fmt.Errorf("settings: remove snapshot repo: %w", err)
		}
	}
	for _, r := range changed {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO snapshot_cache (forge, credential, repo, payload_json, fetched_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (forge, credential, repo) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
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
