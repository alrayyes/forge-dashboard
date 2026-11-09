package dashboard_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAggregator_Refresh_PullRequestMergedBetweenReads_DropsTheRow(t *testing.T) {
	t.Parallel()

	client := twoRepoClient()
	agg := newFlakyAggregator(client)
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().PullRequests, 2)

	// o/a#1 merged on the forge: the repo now lists no open pull request.
	client.prsByRepo["o/a"] = nil
	agg.Refresh(t.Context())

	snap := agg.Get()
	require.Len(t, snap.PullRequests, 1, "a pull request the forge no longer lists is gone, not carried over")
	assert.Equal(t, "o/b", snap.PullRequests[0].Repo)
	for _, r := range snap.Repos {
		assert.Nil(t, r.StaleSince, "%s read fine", r.FullName)
	}
}

// slowIssuesClient holds the first ListOpenIssues call until released, so a
// scoped refresh can sit between reading a repo's pull requests and merging.
type slowIssuesClient struct {
	*flakyForgeClient
	reached chan struct{}
	release chan struct{}
	armed   atomic.Bool
}

func (c *slowIssuesClient) ListOpenIssues(ctx context.Context, owner, name, repo string) ([]dashboard.Issue, error) {
	if c.armed.CompareAndSwap(true, false) {
		close(c.reached)
		<-c.release
	}

	return c.flakyForgeClient.ListOpenIssues(ctx, owner, name, repo)
}

func TestAggregator_RefreshRepo_ReadBeforeAMergeLandsAfterAFullRefresh_DoesNotBringTheRowBack(t *testing.T) {
	t.Parallel()

	inner := twoRepoClient()
	client := &slowIssuesClient{flakyForgeClient: inner, reached: make(chan struct{}), release: make(chan struct{})}
	agg := dashboard.NewAggregator([]dashboard.Source{dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 2)})

	agg.Refresh(t.Context())
	client.armed.Store(true)

	done := make(chan struct{})
	go func() {
		defer close(done)
		agg.RefreshRepo(t.Context(), dashboard.ForgeForgejo, "o", "a", "o/a")
	}()
	<-client.reached // the scoped refresh has read o/a#1 as open

	inner.prsByRepo["o/a"] = nil // o/a#1 merges on the forge
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().PullRequests, 1)

	close(client.release)
	<-done

	assert.Len(t, agg.Get().PullRequests, 1, "a scoped read from before the merge must not undo a full refresh from after it")
}

func TestAggregator_RefreshRepo_FullRefreshReadNothing_StillAppliesTheScopedRead(t *testing.T) {
	t.Parallel()

	inner := twoRepoClient()
	client := &slowIssuesClient{flakyForgeClient: inner, reached: make(chan struct{}), release: make(chan struct{})}
	agg := dashboard.NewAggregator([]dashboard.Source{dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 2)})
	agg.Refresh(t.Context())

	inner.prsByRepo["o/a"] = nil // merged
	client.armed.Store(true)
	done := make(chan struct{})
	go func() {
		defer close(done)
		agg.RefreshRepo(t.Context(), dashboard.ForgeForgejo, "o", "a", "o/a")
	}()
	<-client.reached // the scoped refresh has read o/a as having no open pull request

	inner.listReposErr = errors.New("forge down") // the full refresh reads nothing
	agg.Refresh(t.Context())

	close(client.release)
	<-done

	assert.Len(t, agg.Get().PullRequests, 1, "a full refresh that read nothing must not discard what a scoped read found")
}

func TestAggregator_Refresh_ForgeHeldBackOnItsBudget_MarksTheRowsItCarriesStale(t *testing.T) {
	t.Parallel()

	inner := twoRepoClient()
	client := &fakeRateLimitedForgeClient{
		fakeForgeClient: inner.fakeForgeClient,
		rateLimit:       dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: time.Now().Add(time.Hour)},
	}
	agg := dashboard.NewAggregator([]dashboard.Source{dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 2)})
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().PullRequests, 2)

	// The forge no longer lists o/a#1, but the budget is spent, so nothing is read.
	client.prsByRepo["o/a"] = nil
	agg.Refresh(t.Context())

	snap := agg.Get()
	require.Len(t, snap.PullRequests, 2, "nothing was read, so the old rows are all there is")
	for _, r := range snap.Repos {
		assert.NotNil(t, r.StaleSince, "%s was not read this refresh and must say so", r.FullName)
	}
}
