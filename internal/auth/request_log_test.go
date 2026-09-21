package auth_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStore_RecordRequest_RoundTripsEveryField(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	limit, remaining, cost := 5000, 4999, 1
	resetsAt := time.Now().UTC().Truncate(time.Second)
	loggedAt := time.Now().UTC().Truncate(time.Second)

	require.NoError(t, store.RecordRequest(t.Context(), auth.RequestLogRow{
		LoggedAt:           loggedAt,
		Forge:              "github",
		AccountID:          "acct-1",
		Method:             "POST",
		Endpoint:           "/graphql",
		StatusCode:         200,
		Outcome:            "success",
		RateLimitLimit:     &limit,
		RateLimitRemaining: &remaining,
		RateLimitResetsAt:  &resetsAt,
		RateLimitCost:      &cost,
	}, 10000))

	rows, err := store.ListRequests(t.Context(), auth.RequestLogFilter{})
	require.NoError(t, err)
	require.Len(t, rows, 1)

	row := rows[0]
	assert.Equal(t, loggedAt, row.LoggedAt)
	assert.Equal(t, "github", row.Forge)
	assert.Equal(t, "acct-1", row.AccountID)
	assert.Equal(t, "POST", row.Method)
	assert.Equal(t, "/graphql", row.Endpoint)
	assert.Equal(t, 200, row.StatusCode)
	assert.Equal(t, "success", row.Outcome)
	require.NotNil(t, row.RateLimitLimit)
	assert.Equal(t, limit, *row.RateLimitLimit)
	require.NotNil(t, row.RateLimitRemaining)
	assert.Equal(t, remaining, *row.RateLimitRemaining)
	require.NotNil(t, row.RateLimitResetsAt)
	assert.Equal(t, resetsAt, *row.RateLimitResetsAt)
	require.NotNil(t, row.RateLimitCost)
	assert.Equal(t, cost, *row.RateLimitCost)
}

func TestStore_RecordRequest_NoRateLimitFields_ReadsBackNil(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.RecordRequest(t.Context(), auth.RequestLogRow{
		LoggedAt: time.Now().UTC(),
		Forge:    "forgejo",
		Method:   "GET",
		Endpoint: "/repos/x/y/pulls",
		Outcome:  "success",
	}, 10000))

	rows, err := store.ListRequests(t.Context(), auth.RequestLogFilter{})
	require.NoError(t, err)
	require.Len(t, rows, 1)

	assert.Nil(t, rows[0].RateLimitLimit)
	assert.Nil(t, rows[0].RateLimitRemaining)
	assert.Nil(t, rows[0].RateLimitResetsAt)
	assert.Nil(t, rows[0].RateLimitCost)
	assert.Equal(t, 0, rows[0].StatusCode)
	assert.Empty(t, rows[0].AccountID)
}

func TestStore_RecordRequest_PastRetentionCap_DiscardsOldest(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	const maxEntries = 5
	for i := range maxEntries + 3 {
		require.NoError(t, store.RecordRequest(t.Context(), auth.RequestLogRow{
			LoggedAt: time.Now().UTC(),
			Forge:    "github",
			Method:   "GET",
			Endpoint: "/x",
			Outcome:  "success",
		}, maxEntries))
		_ = i
	}

	rows, err := store.ListRequests(t.Context(), auth.RequestLogFilter{})
	require.NoError(t, err)
	assert.Len(t, rows, maxEntries)
}

func TestStore_ListRequests_FilterByForge_Narrows(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.RecordRequest(t.Context(), auth.RequestLogRow{
		LoggedAt: time.Now().UTC(), Forge: "github", Method: "GET", Endpoint: "/a", Outcome: "success",
	}, 10000))
	require.NoError(t, store.RecordRequest(t.Context(), auth.RequestLogRow{
		LoggedAt: time.Now().UTC(), Forge: "forgejo", Method: "GET", Endpoint: "/b", Outcome: "success",
	}, 10000))

	rows, err := store.ListRequests(t.Context(), auth.RequestLogFilter{Forge: "forgejo"})
	require.NoError(t, err)

	require.Len(t, rows, 1)
	assert.Equal(t, "forgejo", rows[0].Forge)
}

func TestStore_ListRequests_FilterByAccount_Narrows(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.RecordRequest(t.Context(), auth.RequestLogRow{
		LoggedAt: time.Now().UTC(), Forge: "github", AccountID: "acct-1", Method: "GET", Endpoint: "/a", Outcome: "success",
	}, 10000))
	require.NoError(t, store.RecordRequest(t.Context(), auth.RequestLogRow{
		LoggedAt: time.Now().UTC(), Forge: "github", AccountID: "acct-2", Method: "GET", Endpoint: "/b", Outcome: "success",
	}, 10000))

	rows, err := store.ListRequests(t.Context(), auth.RequestLogFilter{AccountID: "acct-2"})
	require.NoError(t, err)

	require.Len(t, rows, 1)
	assert.Equal(t, "acct-2", rows[0].AccountID)
}

func TestStore_ListRequests_NoMatches_ReturnsEmptyNotError(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	rows, err := store.ListRequests(t.Context(), auth.RequestLogFilter{Forge: "github"})
	require.NoError(t, err)
	assert.Empty(t, rows)
}

func TestStore_ListRequests_NewestFirst(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.RecordRequest(t.Context(), auth.RequestLogRow{
		LoggedAt: time.Now().UTC(), Forge: "github", Method: "GET", Endpoint: "/first", Outcome: "success",
	}, 10000))
	require.NoError(t, store.RecordRequest(t.Context(), auth.RequestLogRow{
		LoggedAt: time.Now().UTC(), Forge: "github", Method: "GET", Endpoint: "/second", Outcome: "success",
	}, 10000))

	rows, err := store.ListRequests(t.Context(), auth.RequestLogFilter{})
	require.NoError(t, err)

	require.Len(t, rows, 2)
	assert.Equal(t, "/second", rows[0].Endpoint)
	assert.Equal(t, "/first", rows[1].Endpoint)
}
