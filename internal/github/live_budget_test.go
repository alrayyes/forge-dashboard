package github_test

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// budgetServer answers every GraphQL query with one repo, and reports whatever
// remaining holds in the rate limit headers, as GitHub does on each response.
type budgetServer struct {
	*httptest.Server

	remaining atomic.Int64
	queries   atomic.Int64
	// ended puts the reported window in the past.
	ended atomic.Bool
}

const budgetLimit = 5000

func newBudgetServer(t *testing.T, owner string) *budgetServer {
	t.Helper()

	repo := map[string]any{
		"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
		"owner":        map[string]any{"login": owner},
		"pullRequests": map[string]any{"nodes": []map[string]any{}},
		"issues":       map[string]any{"nodes": []map[string]any{}},
	}
	resets := time.Now().Add(time.Hour).UTC()
	s := &budgetServer{}
	s.remaining.Store(budgetLimit)
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		s.queries.Add(1)
		w.Header().Set("X-RateLimit-Limit", strconv.Itoa(budgetLimit))
		w.Header().Set("X-RateLimit-Remaining", strconv.FormatInt(s.remaining.Load(), 10))
		reset := resets
		if s.ended.Load() {
			reset = resets.Add(-2 * time.Hour)
		}
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset.Unix(), 10))
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": map[string]any{"limit": budgetLimit, "cost": 1, "remaining": budgetLimit, "resetAt": resets.Format(time.RFC3339)},
			"viewer": map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false, "endCursor": ""},
				"nodes":    []map[string]any{repo},
			}},
			"repository": repo,
		}})
	})
	s.Server = httptest.NewServer(mux)
	t.Cleanup(s.Close)

	return s
}

// The full refresh saw a full budget. A later scoped refresh is the first to
// hear that it is nearly gone, and the one after it must listen.
func TestAggregatorScopedRefresh_StopsOnceAResponseReportsTheReserve(t *testing.T) {
	t.Parallel()

	srv := newBudgetServer(t, "alrayyes")
	agg := dashboard.NewAggregator([]dashboard.Source{github.NewClient("test-token", "", srv.URL)})
	agg.Refresh(t.Context())
	refresh := func() {
		require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a"))
	}

	srv.remaining.Store(budgetLimit / 10)
	refresh()
	spent := srv.queries.Load()
	refresh()

	assert.Equal(t, spent, srv.queries.Load(), "at the reserve, no more queries")
}

// Each installation has a budget of its own, so a repo is judged by the one
// that reads it, and account-wide work by the tightest.
func TestMulti_LatestBudgets_AreThoseOfTheMemberThatReadsTheRepo(t *testing.T) {
	t.Parallel()

	low, high := newBudgetServer(t, "other"), newBudgetServer(t, "alrayyes")
	low.remaining.Store(10)
	high.remaining.Store(4000)
	multi := github.NewMulti([]github.Member{
		{ID: 1, Account: "other", Source: github.NewClient("t1", "", low.URL)},
		{ID: 2, Account: "alrayyes", Source: github.NewClient("t2", "", high.URL)},
	})
	require.True(t, multi.Fetch(t.Context()).Health.Reachable)
	for _, owner := range []string{"other", "alrayyes"} {
		_, _, err := multi.FetchRepo(t.Context(), owner, "a", owner+"/a")
		require.NoError(t, err)
	}

	own, _ := multi.LatestBudgets("alrayyes", "a")
	all, _ := multi.LatestBudgets("", "")

	require.NotNil(t, own)
	require.NotNil(t, all)
	assert.Equal(t, 4000, own.Remaining)
	assert.Equal(t, 10, all.Remaining)
}

// A budget whose window has ended has been refilled since, so it must not hold
// the whole account back for the others.
func TestMulti_LatestBudgets_PassOverAWindowThatHasEnded(t *testing.T) {
	t.Parallel()

	stale, current := newBudgetServer(t, "other"), newBudgetServer(t, "alrayyes")
	stale.remaining.Store(10)
	stale.ended.Store(true)
	current.remaining.Store(4000)
	multi := github.NewMulti([]github.Member{
		{ID: 1, Account: "other", Source: github.NewClient("t1", "", stale.URL)},
		{ID: 2, Account: "alrayyes", Source: github.NewClient("t2", "", current.URL)},
	})
	require.True(t, multi.Fetch(t.Context()).Health.Reachable)

	all, _ := multi.LatestBudgets("", "")

	require.NotNil(t, all)
	assert.Equal(t, 4000, all.Remaining)
}
