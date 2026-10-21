package settings_test

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"modernc.org/sqlite"
)

// stmtLog records every statement that reaches the database.
type stmtLog struct {
	mu    sync.Mutex
	stmts []string
}

func (l *stmtLog) add(q string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.stmts = append(l.stmts, q)
}

func (l *stmtLog) reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.stmts = nil
}

func (l *stmtLog) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()

	return append([]string(nil), l.stmts...)
}

type countingConnector struct {
	dsn string
	log *stmtLog
}

func (c countingConnector) Connect(context.Context) (driver.Conn, error) {
	inner, err := (&sqlite.Driver{}).Open(c.dsn)
	if err != nil {
		return nil, err //nolint:wrapcheck // test helper
	}

	return &countingConn{Conn: inner, log: c.log}, nil
}

func (c countingConnector) Driver() driver.Driver { return &sqlite.Driver{} }

type countingConn struct {
	driver.Conn
	log *stmtLog
}

func (c *countingConn) Prepare(q string) (driver.Stmt, error) {
	c.log.add(q)

	return c.Conn.Prepare(q) //nolint:wrapcheck // test helper
}

func (c *countingConn) ExecContext(ctx context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	c.log.add(q)

	return c.Conn.(driver.ExecerContext).ExecContext(ctx, q, args) //nolint:wrapcheck,forcetypeassert // test helper
}

func (c *countingConn) QueryContext(ctx context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	c.log.add(q)

	return c.Conn.(driver.QueryerContext).QueryContext(ctx, q, args) //nolint:wrapcheck,forcetypeassert // test helper
}

func (c *countingConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	return c.Conn.(driver.ConnBeginTx).BeginTx(ctx, opts) //nolint:wrapcheck,forcetypeassert // test helper
}

// openCountingStore is a cache store whose statements are logged; the log is
// emptied once Init is done, so it holds only what the test then does.
func openCountingStore(t *testing.T) (*settings.Store, *stmtLog) {
	t.Helper()
	log := &stmtLog{}
	db := sql.OpenDB(countingConnector{dsn: dbdsn.For(filepath.Join(t.TempDir(), "s.db")), log: log})
	t.Cleanup(func() { _ = db.Close() })
	cipher, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)
	store := settings.NewStore(db, cipher)
	require.NoError(t, store.Init(t.Context()))
	log.reset()

	return store, log
}

func TestStore_SaveETag_DoesNotScanTheTableToMeasureIt(t *testing.T) {
	t.Parallel()
	store, log := openCountingStore(t)
	require.NoError(t, store.SaveETag(t.Context(), "github", "c", "a", "", `"1"`, []byte("123456"), nil))
	log.reset()

	require.NoError(t, store.SaveETag(t.Context(), "github", "c", "b", "", `"2"`, []byte("123456"), nil))

	for _, q := range log.all() {
		assert.NotContains(t, strings.ToUpper(q), "SUM(", "a save must not total every body: %s", q)
	}
}

func TestStore_ETag_EvictsTheLeastRecentlyUsedFirst(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	store.SetETagCap(13)
	ctx := t.Context()
	require.NoError(t, store.SaveETag(ctx, "github", "c", "kept", "", `"1"`, []byte("123456"), nil))
	time.Sleep(2 * time.Millisecond)
	require.NoError(t, store.SaveETag(ctx, "github", "c", "idle", "", `"2"`, []byte("123456"), nil))
	time.Sleep(2 * time.Millisecond)
	require.NoError(t, store.TouchETag(ctx, "github", "c", "kept", ""))
	time.Sleep(2 * time.Millisecond)

	require.NoError(t, store.SaveETag(ctx, "github", "c", "new", "", `"3"`, []byte("123456"), nil))

	_, _, _, keptOK, _ := store.LoadETag(ctx, "github", "c", "kept", "")
	_, _, _, idleOK, _ := store.LoadETag(ctx, "github", "c", "idle", "")
	_, _, _, newOK, _ := store.LoadETag(ctx, "github", "c", "new", "")
	assert.True(t, keptOK, "an entry that keeps getting 304s survives")
	assert.False(t, idleOK, "the one nobody asked for went")
	assert.True(t, newOK)
}

func TestStore_ETag_ABodyOverTheCapIsNeverSaved(t *testing.T) {
	t.Parallel()
	store, log := openCountingStore(t)
	store.SetETagCap(5)
	ctx := t.Context()
	require.NoError(t, store.SaveETag(ctx, "github", "c", "small", "", `"1"`, []byte("123"), nil))
	log.reset()

	require.NoError(t, store.SaveETag(ctx, "github", "c", "huge", "", `"2"`, []byte("1234567890"), nil))

	_, _, _, hugeOK, _ := store.LoadETag(ctx, "github", "c", "huge", "")
	_, _, _, smallOK, _ := store.LoadETag(ctx, "github", "c", "small", "")
	assert.False(t, hugeOK)
	assert.True(t, smallOK, "saving it must not push the others out")
	for _, q := range log.all() {
		assert.NotContains(t, strings.ToUpper(q), "INSERT INTO HTTP_ETAGS", "it is never written")
	}
}

func TestStore_ETag_AnOversizedAnswerDropsTheOlderOneForTheSameURL(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	store.SetETagCap(5)
	ctx := t.Context()
	require.NoError(t, store.SaveETag(ctx, "github", "c", "u", "", `"1"`, []byte("123"), nil))

	require.NoError(t, store.SaveETag(ctx, "github", "c", "u", "", `"2"`, []byte("1234567890"), nil))

	_, _, _, ok, _ := store.LoadETag(ctx, "github", "c", "u", "")
	assert.False(t, ok, "the old etag no longer matches the forge's answer")
}

func TestStore_ETag_TheByteTotalFollowsReplacements(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	store.SetETagCap(10)
	ctx := t.Context()
	require.NoError(t, store.SaveETag(ctx, "github", "c", "a", "", `"1"`, []byte("123456"), nil))
	time.Sleep(2 * time.Millisecond)
	// Replacing a with 2 bytes frees 4, so b (6) fits beside it.
	require.NoError(t, store.SaveETag(ctx, "github", "c", "a", "", `"2"`, []byte("12"), nil))
	require.NoError(t, store.SaveETag(ctx, "github", "c", "b", "", `"3"`, []byte("123456"), nil))

	_, _, _, aOK, _ := store.LoadETag(ctx, "github", "c", "a", "")
	_, _, _, bOK, _ := store.LoadETag(ctx, "github", "c", "b", "")

	assert.True(t, aOK)
	assert.True(t, bOK, "a stale total would have evicted something")
}
