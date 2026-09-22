package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// TestAggregator_PollCI_RefreshesRepoWithPendingCI is #177's own fix: a
// real Forgejo instance silently drops the "status" webhook event
// (confirmed live, twice — the original investigation and again against
// git.higherlearning.eu), so a check finishing there never triggers the
// scoped refresh a working webhook would. PollCI is the fallback —
// scoped to exactly the repos where a finished check could actually
// change something, not every tracked repo.
func TestAggregator_PollCI_RefreshesRepoWithPendingCI(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, CI: dashboard.CIPending},
	})

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	assert.Equal(t, 0, src.repoFetchCallCount("alrayyes/a"), "no scoped fetch yet — only the initial full Refresh ran")

	agg.PollCI(t.Context())

	assert.Equal(t, 1, src.repoFetchCallCount("alrayyes/a"), "a repo with an open, CI-pending pull request should get a scoped refresh")
}

// A pull request whose CI already resolved can't change on a re-poll —
// polling it anyway would just be wasted API budget for a signal that's
// already final.
func TestAggregator_PollCI_SkipsRepoWithResolvedCI(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, CI: dashboard.CISuccess},
	})

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, 0, src.repoFetchCallCount("alrayyes/a"), "CI already resolved — nothing here can still change")
}

// A tracked repo with no open pull requests at all has nothing PollCI
// could ever act on, so it makes no forge API call for it — the same
// "don't spend budget where there's nothing to check" reasoning the
// resolved-CI case above applies, just for the emptier case.
func TestAggregator_PollCI_MakesNoCallsForRepoWithNoPullRequests(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", nil)

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, 0, src.repoFetchCallCount("alrayyes/a"))
}

// Two pull requests in the same repo, both CI-pending, still produce
// exactly one scoped refresh for that repo — PollCI dedupes by repo,
// not by pull request.
func TestAggregator_PollCI_DedupesMultiplePendingPullRequestsInSameRepo(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, CI: dashboard.CIPending},
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, CI: dashboard.CIPending},
	})

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, 1, src.repoFetchCallCount("alrayyes/a"))
}
