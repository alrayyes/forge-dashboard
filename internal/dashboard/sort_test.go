package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestAggregator_Refresh_SortsByMostRecentlyUpdatedFirst is a regression
// test for a real incident: the dashboard never sorted its pull-request
// and issue lists at all, so a brand new one's visibility on the client's
// paginated board (25 per page, itself unsorted) was pure luck of
// insertion order — confirmed live on an account with 44 open issues
// where a newly created one didn't show up. Two sources deliberately, so
// this also proves the sort is global, not just within one source's own
// results.
func TestAggregator_Refresh_SortsByMostRecentlyUpdatedFirst(t *testing.T) {
	t.Parallel()

	oldest := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	middle := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	newest := time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC)

	gh := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, UpdatedAt: oldest},
		},
		Issues: []dashboard.Issue{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, UpdatedAt: middle},
		},
	}}
	fj := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeForgejo, Repo: "alrayyes/b", Number: 3, UpdatedAt: newest},
		},
		Issues: []dashboard.Issue{
			{Forge: dashboard.ForgeForgejo, Repo: "alrayyes/b", Number: 4, UpdatedAt: newest},
		},
	}}

	agg := dashboard.NewAggregator([]dashboard.Source{gh, fj})
	agg.Refresh(t.Context())
	snap := agg.Get()

	t.Run("pull requests sorted newest first, across sources", func(t *testing.T) {
		t.Parallel()
		require.Len(t, snap.PullRequests, 2)
		assert.Equal(t, 3, snap.PullRequests[0].Number, "the newest PR (forgejo) should sort first, ahead of the older github one")
		assert.Equal(t, 1, snap.PullRequests[1].Number)
	})
	t.Run("issues sorted newest first, across sources", func(t *testing.T) {
		t.Parallel()
		require.Len(t, snap.Issues, 2)
		assert.Equal(t, 4, snap.Issues[0].Number, "the newest issue (forgejo) should sort first, ahead of the older github one")
		assert.Equal(t, 2, snap.Issues[1].Number)
	})
}

func TestAggregator_RefreshRepo_MergedResultStaysSortedGlobally(t *testing.T) {
	t.Parallel()

	oldest := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	newest := time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC)

	src := newFakeRepoRefresherSource()
	// repo "a" starts with the newest activity; repo "b" is older. A
	// naive merge appends the just-refreshed repo's items at the tail
	// regardless of recency — this is exactly the bug: refreshing "b"
	// (the OLDER repo) must not push it after "a" just because it was
	// fetched more recently in wall-clock time. Sorting has to key off
	// each item's own UpdatedAt, not merge order.
	src.setRepo("alrayyes/a", []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, UpdatedAt: newest},
	})
	src.setRepo("alrayyes/b", []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/b", Number: 2, UpdatedAt: oldest},
	})

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	ok := agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "b", "alrayyes/b")
	require.True(t, ok)

	snap := agg.Get()
	require.Len(t, snap.PullRequests, 2)
	assert.Equal(t, 1, snap.PullRequests[0].Number, "repo a's newer PR should still sort first after refreshing repo b")
	assert.Equal(t, 2, snap.PullRequests[1].Number)
}
