package settings_test

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStore_ETag_RoundTripsAnEntryByForgeCredentialURLAndAccept(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	header := map[string][]string{"Etag": {`"abc"`}, "Link": {"<next>; rel=next"}}

	require.NoError(t, store.SaveETag(t.Context(), "github", "token:ab12", "https://api/x", "application/json", `"abc"`, []byte("body"), header))

	etag, body, got, ok, err := store.LoadETag(t.Context(), "github", "token:ab12", "https://api/x", "application/json")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, `"abc"`, etag)
	assert.Equal(t, []byte("body"), body)
	assert.Equal(t, header, got)

	_, _, _, ok, err = store.LoadETag(t.Context(), "github", "token:other", "https://api/x", "application/json")
	require.NoError(t, err)
	assert.False(t, ok, "another credential has its own entries")
}

func TestStore_ETag_SaveReplacesTheRow(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	require.NoError(t, store.SaveETag(t.Context(), "github", "c", "u", "", `"1"`, []byte("old"), nil))
	require.NoError(t, store.SaveETag(t.Context(), "github", "c", "u", "", `"2"`, []byte("new"), nil))

	etag, body, _, ok, err := store.LoadETag(t.Context(), "github", "c", "u", "")

	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, `"2"`, etag)
	assert.Equal(t, []byte("new"), body)
}

func TestStore_ETag_EvictsTheOldestOnceOverTheSizeCap(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	store.SetETagCap(10)
	require.NoError(t, store.SaveETag(t.Context(), "github", "c", "first", "", `"1"`, []byte("123456"), nil))
	time.Sleep(2 * time.Millisecond)
	require.NoError(t, store.SaveETag(t.Context(), "github", "c", "second", "", `"2"`, []byte("123456"), nil))

	_, _, _, firstOK, err := store.LoadETag(t.Context(), "github", "c", "first", "")
	require.NoError(t, err)
	_, _, _, secondOK, err := store.LoadETag(t.Context(), "github", "c", "second", "")
	require.NoError(t, err)

	assert.False(t, firstOK, "the older entry made room")
	assert.True(t, secondOK)
}

func TestStore_ETag_PrunesNothingUnderTheCap(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	store.SetETagCap(100)
	require.NoError(t, store.SaveETag(t.Context(), "github", "c", "a", "", `"1"`, []byte("123456"), nil))
	require.NoError(t, store.SaveETag(t.Context(), "github", "c", "b", "", `"2"`, []byte("123456"), nil))

	_, _, _, ok, _ := store.LoadETag(t.Context(), "github", "c", "a", "")

	assert.True(t, ok)
}

func TestStore_SnapshotRepos_SaveChangesTouchesOnlyWhatItIsGiven(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	at := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	ctx := t.Context()
	require.NoError(t, store.SaveSnapshotChanges(ctx, dashboard.ForgeGitHub, "c1", []dashboard.CachedRepo{
		{Repo: "o/a", FetchedAt: at, Payload: []byte(`{"a":1}`)},
		{Repo: "o/b", FetchedAt: at, Payload: []byte(`{"b":1}`)},
		{Repo: "o/gone", FetchedAt: at, Payload: []byte(`{}`)},
	}, nil))
	require.NoError(t, store.SaveSnapshotChanges(ctx, dashboard.ForgeGitHub, "c2", []dashboard.CachedRepo{{Repo: "o/other", FetchedAt: at, Payload: []byte(`{}`)}}, nil))

	require.NoError(t, store.SaveSnapshotChanges(ctx, dashboard.ForgeGitHub, "c1",
		[]dashboard.CachedRepo{{Repo: "o/a", FetchedAt: at, Payload: []byte(`{"a":2}`)}}, []string{"o/gone"}))

	got, err := store.LoadSnapshotRepos(ctx, dashboard.ForgeGitHub, "c1")
	require.NoError(t, err)
	require.Len(t, got, 2, "o/gone is removed, o/b is left as it was")
	assert.Equal(t, "o/a", got[0].Repo)
	assert.JSONEq(t, `{"a":2}`, string(got[0].Payload))
	assert.Equal(t, "o/b", got[1].Repo)
	assert.JSONEq(t, `{"b":1}`, string(got[1].Payload))
	other, err := store.LoadSnapshotRepos(ctx, dashboard.ForgeGitHub, "c2")
	require.NoError(t, err)
	assert.Len(t, other, 1, "another credential is untouched")
}

func TestStore_HookChecks_RoundTripAndReplace(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	at := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	ctx := t.Context()
	require.NoError(t, store.SaveHookCheck(ctx, dashboard.ForgeGitHub, "c1", dashboard.HookCheck{Repo: "o/a", Has: true, Events: []string{"push"}, CheckedAt: at}))
	require.NoError(t, store.SaveHookCheck(ctx, dashboard.ForgeGitHub, "c1", dashboard.HookCheck{Repo: "o/b", Refused: true, CheckedAt: at}))
	require.NoError(t, store.SaveHookCheck(ctx, dashboard.ForgeGitHub, "c1", dashboard.HookCheck{Repo: "o/a", Has: true, Events: []string{"push", "check_run"}, CheckedAt: at}))

	got, err := store.LoadHookChecks(ctx, dashboard.ForgeGitHub, "c1")

	require.NoError(t, err)
	require.Len(t, got, 2)
	byRepo := map[string]dashboard.HookCheck{}
	for _, c := range got {
		byRepo[c.Repo] = c
	}
	assert.Equal(t, []string{"push", "check_run"}, byRepo["o/a"].Events)
	assert.True(t, byRepo["o/a"].Has)
	assert.True(t, byRepo["o/b"].Refused)
	assert.True(t, at.Equal(byRepo["o/a"].CheckedAt))
}

func TestStore_WebhookSeen_RoundTripsPerClass(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	t1 := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	t2 := t1.Add(time.Minute)
	ctx := t.Context()
	require.NoError(t, store.SaveWebhookSeen(ctx, dashboard.ForgeGitHub, "c1", dashboard.SeenRecord{Repo: "o/a", Class: dashboard.EventClassCheck, At: t1}))
	require.NoError(t, store.SaveWebhookSeen(ctx, dashboard.ForgeGitHub, "c1", dashboard.SeenRecord{Repo: "o/a", Class: dashboard.EventClassOther, At: t1}))
	require.NoError(t, store.SaveWebhookSeen(ctx, dashboard.ForgeGitHub, "c1", dashboard.SeenRecord{Repo: "o/a", Class: dashboard.EventClassCheck, At: t2}))

	got, err := store.LoadWebhookSeen(ctx, dashboard.ForgeGitHub, "c1")

	require.NoError(t, err)
	require.Len(t, got, 2)
	for _, r := range got {
		if r.Class == dashboard.EventClassCheck {
			assert.True(t, t2.Equal(r.At))
		}
	}
}

func openCacheTestDB(t *testing.T) (*sql.DB, *settings.Store) {
	t.Helper()
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "s.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	cipher, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)
	store := settings.NewStore(db, cipher)
	require.NoError(t, store.Init(t.Context()))

	return db, store
}

func columnsOf(t *testing.T, db *sql.DB, table string) []string {
	t.Helper()
	rows, err := db.QueryContext(t.Context(), `SELECT name FROM pragma_table_info(?)`, table)
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()

	var cols []string
	for rows.Next() {
		var name string
		require.NoError(t, rows.Scan(&name))
		cols = append(cols, name)
	}
	require.NoError(t, rows.Err())

	return cols
}

func TestStore_CacheTables_HaveNoUserIDColumn(t *testing.T) {
	t.Parallel()
	db, _ := openCacheTestDB(t)

	for _, table := range []string{"http_etags", "snapshot_cache", "hook_checks", "webhook_seen"} {
		cols := columnsOf(t, db, table)
		assert.Contains(t, cols, "credential", table)
		assert.Contains(t, cols, "forge", table)
		assert.NotContains(t, cols, "user_id", table)
	}
}

func TestStore_Init_StartsTheCacheEmptyWhenItsSchemaIsOld(t *testing.T) {
	t.Parallel()
	db, store := openCacheTestDB(t)
	require.NoError(t, store.SaveHookCheck(t.Context(), dashboard.ForgeGitHub, "c", dashboard.HookCheck{Repo: "o/a", CheckedAt: time.Now()}))
	_, err := db.ExecContext(t.Context(), `UPDATE cache_schema SET version = 0`)
	require.NoError(t, err)

	require.NoError(t, store.Init(t.Context()))

	got, err := store.LoadHookChecks(t.Context(), dashboard.ForgeGitHub, "c")
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_Init_RebuildsTheCacheWhenItsVersionRowIsDamaged(t *testing.T) {
	t.Parallel()
	db, store := openCacheTestDB(t)
	ctx := t.Context()
	require.NoError(t, store.SaveHookCheck(ctx, dashboard.ForgeGitHub, "c", dashboard.HookCheck{Repo: "o/a", CheckedAt: time.Now()}))
	_, err := db.ExecContext(ctx, `DROP TABLE cache_schema`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `CREATE TABLE cache_schema (version TEXT NOT NULL)`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `INSERT INTO cache_schema (version) VALUES ('not a number')`)
	require.NoError(t, err)

	require.NoError(t, store.Init(ctx))

	got, err := store.LoadHookChecks(ctx, dashboard.ForgeGitHub, "c")
	require.NoError(t, err)
	assert.Empty(t, got, "the disposable cache starts over")
	var version int
	require.NoError(t, db.QueryRowContext(ctx, `SELECT version FROM cache_schema`).Scan(&version))
	assert.Positive(t, version)
}

func TestStore_Init_ReturnsARealDatabaseError(t *testing.T) {
	t.Parallel()
	db, store := openCacheTestDB(t)
	require.NoError(t, db.Close())

	require.Error(t, store.Init(t.Context()))
}

func TestStore_Init_TreatsAnEmptyVersionTableAsAFreshDatabase(t *testing.T) {
	t.Parallel()
	db, store := openCacheTestDB(t)
	_, err := db.ExecContext(t.Context(), `DELETE FROM cache_schema`)
	require.NoError(t, err)

	require.NoError(t, store.Init(t.Context()))

	var version int
	require.NoError(t, db.QueryRowContext(t.Context(), `SELECT version FROM cache_schema`).Scan(&version))
	assert.Positive(t, version)
}

func TestStore_Init_AFailureAfterTheDropLeavesTheOldCacheAndVersion(t *testing.T) {
	t.Parallel()
	db, store := openCacheTestDB(t)
	ctx := t.Context()
	require.NoError(t, store.SaveHookCheck(ctx, dashboard.ForgeGitHub, "c", dashboard.HookCheck{Repo: "o/a", CheckedAt: time.Now()}))
	_, err := db.ExecContext(ctx, `UPDATE cache_schema SET version = 0`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `CREATE TRIGGER block_version_write BEFORE INSERT ON cache_schema
		BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)
	require.NoError(t, err)

	require.Error(t, store.Init(ctx))

	var version int
	require.NoError(t, db.QueryRowContext(ctx, `SELECT version FROM cache_schema`).Scan(&version))
	assert.Equal(t, 0, version, "the version still says the cache is old")
	got, err := store.LoadHookChecks(ctx, dashboard.ForgeGitHub, "c")
	require.NoError(t, err)
	assert.Len(t, got, 1, "the drop was rolled back with the failed version write")
}
