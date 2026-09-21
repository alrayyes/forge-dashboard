package requestlog_test

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func newTestStore(t *testing.T) *auth.Store {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "auth.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))

	return store
}

func TestNoopRecorder_DiscardsWithNoError(t *testing.T) {
	t.Parallel()

	err := requestlog.NoopRecorder{}.Record(t.Context(), requestlog.Entry{})

	assert.NoError(t, err)
}

func TestSQLiteRecorder_Record_StampsItsOwnAccountID(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	rec := requestlog.NewSQLiteRecorder(store, "acct-1")

	require.NoError(t, rec.Record(t.Context(), requestlog.Entry{
		LoggedAt: time.Now().UTC(),
		Forge:    dashboard.ForgeGitHub,
		// Deliberately set to something else — SQLiteRecorder's own
		// bound accountID wins, not whatever the caller put here.
		AccountID: "someone-else",
		Method:    "POST",
		Endpoint:  "/graphql",
		Outcome:   requestlog.OutcomeSuccess,
	}))

	entries, err := rec.List(t.Context(), requestlog.Filter{})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, "acct-1", entries[0].AccountID)
}

func TestSQLiteRecorder_Record_RoundTripsRateLimitFields(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	rec := requestlog.NewSQLiteRecorder(store, "acct-1")

	limit, remaining, cost := 5000, 10, 1
	resetsAt := time.Now().UTC().Truncate(time.Second)

	require.NoError(t, rec.Record(t.Context(), requestlog.Entry{
		LoggedAt:           time.Now().UTC(),
		Forge:              dashboard.ForgeGitHub,
		Method:             "POST",
		Endpoint:           "/graphql",
		StatusCode:         200,
		Outcome:            requestlog.OutcomeSuccess,
		RateLimitLimit:     &limit,
		RateLimitRemaining: &remaining,
		RateLimitResetsAt:  &resetsAt,
		RateLimitCost:      &cost,
	}))

	entries, err := rec.List(t.Context(), requestlog.Filter{})
	require.NoError(t, err)
	require.Len(t, entries, 1)

	e := entries[0]
	assert.Equal(t, dashboard.ForgeGitHub, e.Forge)
	assert.Equal(t, 200, e.StatusCode)
	require.NotNil(t, e.RateLimitLimit)
	assert.Equal(t, limit, *e.RateLimitLimit)
	require.NotNil(t, e.RateLimitRemaining)
	assert.Equal(t, remaining, *e.RateLimitRemaining)
	require.NotNil(t, e.RateLimitResetsAt)
	assert.Equal(t, resetsAt, *e.RateLimitResetsAt)
	require.NotNil(t, e.RateLimitCost)
	assert.Equal(t, cost, *e.RateLimitCost)
}

func TestSQLiteRecorder_Record_RecordsAFailure(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	rec := requestlog.NewSQLiteRecorder(store, "acct-1")

	require.NoError(t, rec.Record(t.Context(), requestlog.Entry{
		LoggedAt: time.Now().UTC(),
		Forge:    dashboard.ForgeGitHub,
		Method:   "POST",
		Endpoint: "/graphql",
		Outcome:  string(dashboard.ForgeErrorRateLimited),
	}))

	entries, err := rec.List(t.Context(), requestlog.Filter{})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, string(dashboard.ForgeErrorRateLimited), entries[0].Outcome)
}

func TestSQLiteRecorder_List_FiltersByForge(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	rec := requestlog.NewSQLiteRecorder(store, "acct-1")

	require.NoError(t, rec.Record(t.Context(), requestlog.Entry{
		LoggedAt: time.Now().UTC(), Forge: dashboard.ForgeGitHub, Method: "GET", Endpoint: "/a", Outcome: requestlog.OutcomeSuccess,
	}))
	require.NoError(t, rec.Record(t.Context(), requestlog.Entry{
		LoggedAt: time.Now().UTC(), Forge: dashboard.ForgeForgejo, Method: "GET", Endpoint: "/b", Outcome: requestlog.OutcomeSuccess,
	}))

	entries, err := rec.List(t.Context(), requestlog.Filter{Forge: dashboard.ForgeForgejo})
	require.NoError(t, err)

	require.Len(t, entries, 1)
	assert.Equal(t, dashboard.ForgeForgejo, entries[0].Forge)
}
