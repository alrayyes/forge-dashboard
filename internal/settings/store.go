package settings

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"
	"time"
)

// ErrNotFound is returned when a user has never saved any credentials.
var ErrNotFound = errors.New("settings: not found")

// Credentials is one user's forge configuration, decrypted and ready to
// use — never itself serialized back to a client once saved; see
// internal/api's settings handlers for what does reach the browser.
type Credentials struct {
	GitHubToken     string
	GitHubUsername  string
	ForgejoURL      string
	ForgejoToken    string
	ForgejoUsername string
	// WebhookToken identifies this user in a webhook URL
	// (/api/webhooks/{provider}/{token}); WebhookSecret is what's pasted
	// into the forge's own webhook "Secret" field and never appears in
	// the URL, so a leaked log line alone can't forge a valid signature.
	// Neither is a third-party credential the way the forge tokens above
	// are, so neither is encrypted at rest — see EnsureWebhookCredentials.
	WebhookToken  string
	WebhookSecret string
	// AllowBotPrUpdates overrides the default restraint the Update
	// branch/Dependabot/Renovate action buttons apply to a pull request
	// opened by release-please, Dependabot, or Renovate: those tools
	// already keep their own PRs current on their own schedule, so a
	// manual "Update branch" click is redundant at best and, for
	// release-please specifically (which regenerates the PR's branch
	// and changelog together on every push to the base branch), a
	// genuine risk of fighting its own next run. False (the default,
	// Go's zero value) is "leave bot-managed PRs alone"; true opts back
	// into treating them the same as any other PR.
	AllowBotPrUpdates bool
	// RenovateRebaseLabel is the label Renovate's own rebase/retry
	// trigger listens for on a given repo (Renovate's own rebaseLabel
	// config option — "rebase" is Renovate's own default, but this is
	// genuinely per-repo configurable, so it's a user-set override
	// rather than a hardcoded constant). Empty means "use Renovate's own
	// default" — see renovateRebaseLabelOrDefault.
	RenovateRebaseLabel string
	// Theme is "light", "dark", or "" (system — the default, matching
	// theme.js's own old cookie-unset behavior). Set only from Settings
	// (#352: no header toggle anywhere else) and read on every page load
	// via the lightweight GET /api/settings/theme, the same
	// "don't provision webhook credentials just to check one field"
	// restraint GET /api/settings/bot-pr-updates already has.
	Theme     string
	UpdatedAt time.Time
}

// renovateRebaseLabelDefault is Renovate's own documented default for its
// rebaseLabel config option — https://docs.renovatebot.com/configuration-options/#rebaselabel.
const renovateRebaseLabelDefault = "rebase"

// RenovateRebaseLabelOrDefault resolves c's own saved label, falling back
// to Renovate's documented default when the user has never set one.
func (c Credentials) RenovateRebaseLabelOrDefault() string {
	if c.RenovateRebaseLabel == "" {
		return renovateRebaseLabelDefault
	}

	return c.RenovateRebaseLabel
}

// Store persists Credentials, encrypted at rest, one row per user.
type Store struct {
	db     *sql.DB
	cipher *Cipher
}

// NewStore wraps db, encrypting and decrypting every token field through
// cipher. Init must be called once before any other method.
func NewStore(db *sql.DB, cipher *Cipher) *Store {
	return &Store{db: db, cipher: cipher}
}

// Init creates the schema if it doesn't already exist. Safe to call every
// startup.
func (s *Store) Init(ctx context.Context) error {
	const schema = `
	CREATE TABLE IF NOT EXISTS user_credentials (
		user_id TEXT PRIMARY KEY,
		github_token TEXT NOT NULL DEFAULT '',
		github_username TEXT NOT NULL DEFAULT '',
		forgejo_url TEXT NOT NULL DEFAULT '',
		forgejo_token TEXT NOT NULL DEFAULT '',
		forgejo_username TEXT NOT NULL DEFAULT '',
		webhook_token TEXT NOT NULL DEFAULT '',
		webhook_secret TEXT NOT NULL DEFAULT '',
		allow_bot_pr_updates BOOLEAN NOT NULL DEFAULT 0,
		renovate_rebase_label TEXT NOT NULL DEFAULT '',
		filter_state TEXT NOT NULL DEFAULT '{}',
		theme TEXT NOT NULL DEFAULT '',
		updated_at TIMESTAMP NOT NULL
	);
	CREATE TABLE IF NOT EXISTS webhook_deliveries (
		user_id TEXT NOT NULL,
		forge TEXT NOT NULL,
		repo_full_name TEXT NOT NULL,
		last_seen_at TIMESTAMP NOT NULL,
		PRIMARY KEY (user_id, forge, repo_full_name)
	);
	CREATE TABLE IF NOT EXISTS ignored_repos (
		user_id TEXT NOT NULL,
		forge TEXT NOT NULL,
		repo_full_name TEXT NOT NULL,
		PRIMARY KEY (user_id, forge, repo_full_name)
	);
	`
	if _, err := s.db.ExecContext(ctx, schema); err != nil {
		return err
	}

	return s.addColumnsIfMissing(ctx)
}

// addColumnsIfMissing exists for a database that already had this table
// before a column below was added — CREATE TABLE IF NOT EXISTS above is a
// no-op against it, so the column needs adding here instead. SQLite has no
// ADD COLUMN IF NOT EXISTS, so a "duplicate column name" error is the
// expected, ignored outcome on a database that already has it (including
// every fresh one, which got it from the CREATE TABLE above already).
func (s *Store) addColumnsIfMissing(ctx context.Context) error {
	migrations := []string{
		`ALTER TABLE user_credentials ADD COLUMN webhook_token TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE user_credentials ADD COLUMN webhook_secret TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE user_credentials ADD COLUMN allow_bot_pr_updates BOOLEAN NOT NULL DEFAULT 0`,
		`ALTER TABLE user_credentials ADD COLUMN renovate_rebase_label TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE user_credentials ADD COLUMN filter_state TEXT NOT NULL DEFAULT '{}'`,
		`ALTER TABLE user_credentials ADD COLUMN theme TEXT NOT NULL DEFAULT ''`,
	}
	for _, stmt := range migrations {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			if strings.Contains(err.Error(), "duplicate column name") {
				continue
			}

			return err
		}
	}

	return nil
}

// Set replaces userID's entire credential row — a Settings save is always
// a full form submit, not a partial patch.
func (s *Store) Set(ctx context.Context, userID []byte, c Credentials) error {
	encGitHubToken, err := s.cipher.Encrypt(c.GitHubToken)
	if err != nil {
		return err
	}
	encForgejoToken, err := s.cipher.Encrypt(c.ForgejoToken)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO user_credentials
			(user_id, github_token, github_username, forgejo_url, forgejo_token, forgejo_username, allow_bot_pr_updates, renovate_rebase_label, theme, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET
			github_token = excluded.github_token,
			github_username = excluded.github_username,
			forgejo_url = excluded.forgejo_url,
			forgejo_token = excluded.forgejo_token,
			forgejo_username = excluded.forgejo_username,
			allow_bot_pr_updates = excluded.allow_bot_pr_updates,
			renovate_rebase_label = excluded.renovate_rebase_label,
			theme = excluded.theme,
			updated_at = excluded.updated_at`,
		encodeUserID(userID), encGitHubToken, c.GitHubUsername, c.ForgejoURL, encForgejoToken, c.ForgejoUsername, c.AllowBotPrUpdates, c.RenovateRebaseLabel, c.Theme, time.Now().UTC(),
	)

	return err
}

// Get returns ErrNotFound when userID has never saved any credentials.
func (s *Store) Get(ctx context.Context, userID []byte) (Credentials, error) {
	var (
		c                               Credentials
		encGitHubToken, encForgejoToken string
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT github_token, github_username, forgejo_url, forgejo_token, forgejo_username, webhook_token, webhook_secret, allow_bot_pr_updates, renovate_rebase_label, theme, updated_at
		FROM user_credentials WHERE user_id = ?`,
		encodeUserID(userID),
	).Scan(&encGitHubToken, &c.GitHubUsername, &c.ForgejoURL, &encForgejoToken, &c.ForgejoUsername, &c.WebhookToken, &c.WebhookSecret, &c.AllowBotPrUpdates, &c.RenovateRebaseLabel, &c.Theme, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Credentials{}, ErrNotFound
	}
	if err != nil {
		return Credentials{}, err
	}

	if c.GitHubToken, err = s.cipher.Decrypt(encGitHubToken); err != nil {
		return Credentials{}, err
	}
	if c.ForgejoToken, err = s.cipher.Decrypt(encForgejoToken); err != nil {
		return Credentials{}, err
	}

	return c, nil
}

// EnsureWebhookCredentials returns userID's webhook token and secret,
// generating and persisting them on first call — a user who never opens
// Settings never gets a row touched for this, and a repeat call always
// returns the same values (a webhook already configured on a forge
// points at a URL built from the token; it can't change underneath it).
// Doesn't touch any other field, including on a user who has no saved
// row at all yet.
func (s *Store) EnsureWebhookCredentials(ctx context.Context, userID []byte) (token, secret string, err error) {
	encodedID := encodeUserID(userID)

	err = s.db.QueryRowContext(ctx,
		`SELECT webhook_token, webhook_secret FROM user_credentials WHERE user_id = ?`, encodedID,
	).Scan(&token, &secret)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		// No row at all yet — proceed to create one with just the
		// webhook fields; a later real Set upserts the rest around it.
	case err != nil:
		return "", "", err
	case token != "" && secret != "":
		return token, secret, nil
	}

	if token == "" {
		if token, err = randomWebhookValue(); err != nil {
			return "", "", err
		}
	}
	if secret == "" {
		if secret, err = randomWebhookValue(); err != nil {
			return "", "", err
		}
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO user_credentials (user_id, webhook_token, webhook_secret, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET
			webhook_token = excluded.webhook_token,
			webhook_secret = excluded.webhook_secret`,
		encodedID, token, secret, time.Now().UTC(),
	)
	if err != nil {
		return "", "", err
	}

	return token, secret, nil
}

// FindByWebhookToken looks up which user a webhook token belongs to and
// their signing secret, for verifying an inbound webhook delivery.
// Returns ErrNotFound for any token with no match — including the empty
// string, which every row that's never called EnsureWebhookCredentials
// shares as its default, and which would otherwise resolve to whichever
// of them the query happened to return first.
func (s *Store) FindByWebhookToken(ctx context.Context, token string) (userID []byte, secret string, err error) {
	if token == "" {
		return nil, "", ErrNotFound
	}

	var encodedUserID string
	err = s.db.QueryRowContext(ctx,
		`SELECT user_id, webhook_secret FROM user_credentials WHERE webhook_token = ?`, token,
	).Scan(&encodedUserID, &secret)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}

	userID, err = base64.RawURLEncoding.DecodeString(encodedUserID)
	if err != nil {
		return nil, "", err
	}

	return userID, secret, nil
}

// GetFilterState returns userID's own saved dashboard/Insights filter
// state as a raw JSON blob (#353) — "{}" for a user who's never saved
// any, the same empty-object shape Filters.defaultState() already
// treats as "nothing set" client-side, not ErrNotFound: no filters
// saved yet is the normal starting state, not a missing-row error the
// way Get's own ErrNotFound is for forge credentials.
func (s *Store) GetFilterState(ctx context.Context, userID []byte) (string, error) {
	var state string
	err := s.db.QueryRowContext(ctx,
		`SELECT filter_state FROM user_credentials WHERE user_id = ?`, encodeUserID(userID),
	).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return "{}", nil
	}
	if err != nil {
		return "", err
	}

	return state, nil
}

// SetFilterState replaces userID's own saved filter state with stateJSON
// verbatim — this Store never parses or validates its shape, the same
// "opaque blob, not this layer's concern" treatment WebAuthnCeremonyOptions
// gets in api/openapi.yaml. Doesn't touch any other field, including on a
// user with no saved row at all yet (EnsureWebhookCredentials' own
// "insert just this one field" shape, not Set's full-row replace — #353's
// whole point is that this saves far more often than a real Settings
// submit does, so it can't wait on one having happened first).
func (s *Store) SetFilterState(ctx context.Context, userID []byte, stateJSON string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO user_credentials (user_id, filter_state, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET filter_state = excluded.filter_state`,
		// updated_at is only ever used for the fresh-row INSERT case above
		// (the ON CONFLICT clause deliberately leaves it out) — the same
		// "this column means a real Settings form save happened" convention
		// EnsureWebhookCredentials already established; a filter-state-only
		// write shouldn't make Settings look more recently touched than it
		// really was.
		encodeUserID(userID), stateJSON, time.Now().UTC(),
	)

	return err
}

// randomWebhookValue returns 256 bits of randomness as a URL-safe string —
// used for both the URL-embedded token and the HMAC-signing secret, which
// need the same shape but are never used interchangeably (see
// Credentials.WebhookToken's doc comment).
func randomWebhookValue() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// Delete removes userID's saved credentials — a no-op, not an error, if
// they never saved any. Used when an admin removes the account outright.
// Also removes their recorded webhook deliveries, the same store's other
// table.
func (s *Store) Delete(ctx context.Context, userID []byte) error {
	encodedID := encodeUserID(userID)
	if _, err := s.db.ExecContext(ctx, `DELETE FROM webhook_deliveries WHERE user_id = ?`, encodedID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM ignored_repos WHERE user_id = ?`, encodedID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM user_credentials WHERE user_id = ?`, encodedID)

	return err
}

// WebhookDeliveryKey is how a repo's forge and full name combine into
// the key WebhookDeliveries' returned set uses — exported so a caller
// never has to know or reproduce the separator itself. IgnoredRepos'
// returned set is keyed the same way, rather than inventing a second,
// differently-shaped helper for an identical (forge, repoFullName) pair.
func WebhookDeliveryKey(forge, repoFullName string) string {
	return forge + "/" + repoFullName
}

// IgnoreRepo marks forge/repoFullName as ignored for userID — its pull
// requests and issues stop appearing in that user's dashboard/Insights
// (see internal/api's buildDashboardResponse), though the repo itself
// keeps being fetched and tracked (#363). Idempotent: ignoring an
// already-ignored repo is a no-op, not an error.
func (s *Store) IgnoreRepo(ctx context.Context, userID []byte, forge, repoFullName string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ignored_repos (user_id, forge, repo_full_name)
		VALUES (?, ?, ?)
		ON CONFLICT (user_id, forge, repo_full_name) DO NOTHING`,
		encodeUserID(userID), forge, repoFullName,
	)

	return err
}

// UnignoreRepo reverses IgnoreRepo. Idempotent: un-ignoring a repo that
// was never ignored is a no-op, not an error.
func (s *Store) UnignoreRepo(ctx context.Context, userID []byte, forge, repoFullName string) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM ignored_repos WHERE user_id = ? AND forge = ? AND repo_full_name = ?`,
		encodeUserID(userID), forge, repoFullName,
	)

	return err
}

// IgnoredRepos returns the set of forge/repo pairs (keyed by
// WebhookDeliveryKey) userID has ignored — empty, never an error, for a
// user who's never ignored anything.
func (s *Store) IgnoredRepos(ctx context.Context, userID []byte) (map[string]struct{}, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT forge, repo_full_name FROM ignored_repos WHERE user_id = ?`, encodeUserID(userID),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	ignored := make(map[string]struct{})
	for rows.Next() {
		var forge, repoFullName string
		if err := rows.Scan(&forge, &repoFullName); err != nil {
			return nil, err
		}
		ignored[WebhookDeliveryKey(forge, repoFullName)] = struct{}{}
	}

	return ignored, rows.Err()
}

// RecordWebhookDelivery notes that userID's webhook for forge/repoFullName
// just delivered a signature-verified event — the passive signal
// WebhookDeliveries reports back as "this repo has a working webhook,"
// since actually asking GitHub/Forgejo whether one's configured would
// need a broader token scope than this app otherwise asks for (see the
// issue this shipped against for why). Safe to call repeatedly; only the
// latest timestamp is kept.
func (s *Store) RecordWebhookDelivery(ctx context.Context, userID []byte, forge, repoFullName string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO webhook_deliveries (user_id, forge, repo_full_name, last_seen_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (user_id, forge, repo_full_name) DO UPDATE SET
			last_seen_at = excluded.last_seen_at`,
		encodeUserID(userID), forge, repoFullName, time.Now().UTC(),
	)

	return err
}

// WebhookDeliveries returns the set of forge/repo pairs (keyed by
// WebhookDeliveryKey) that have ever delivered a signature-verified
// webhook event for userID — empty for a user none of whose repos have,
// never an error for that case.
func (s *Store) WebhookDeliveries(ctx context.Context, userID []byte) (map[string]struct{}, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT forge, repo_full_name FROM webhook_deliveries WHERE user_id = ?`, encodeUserID(userID),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	seen := make(map[string]struct{})
	for rows.Next() {
		var forge, repoFullName string
		if err := rows.Scan(&forge, &repoFullName); err != nil {
			return nil, err
		}
		seen[WebhookDeliveryKey(forge, repoFullName)] = struct{}{}
	}

	return seen, rows.Err()
}

func encodeUserID(id []byte) string { return base64.RawURLEncoding.EncodeToString(id) }
