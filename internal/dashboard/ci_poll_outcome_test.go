package dashboard_test

import (
	"errors"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// polledMinutes ticks the CI poll once per base interval and returns the ticks
// at which calls rose, that is the ticks that actually asked the forge.
func polledMinutes(t *testing.T, agg *dashboard.Aggregator, clock *pollClock, calls func() int, ticks int) []int {
	t.Helper()

	var at []int
	for minute := range ticks {
		before := calls()
		agg.PollCI(t.Context())
		if calls() > before {
			at = append(at, minute)
		}
		clock.advance(pollBase)
	}

	return at
}

func failedAnswer(refs []dashboard.PullRequestRef) dashboard.PendingResult {
	return dashboard.PendingResult{Failed: refs}
}

func TestAggregator_PollCI_AWholeCallFailureIsNotScoredAsUnchanged(t *testing.T) {
	t.Parallel()

	clock := newPollClock()
	src := newBatchSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{pendingPR("alrayyes/a", 1)})
	src.err = errors.New("outage")
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())
	src.failRepoFetches(errors.New("outage"))

	got := polledMinutes(t, agg, clock, src.batchCount, 4)

	assert.Equal(t, []int{0, 1, 2, 3}, got, "nothing was read, so nothing backs off")
}

func TestAggregator_PollCI_AFailedAliasWhoseRepoRefreshFailsIsNotScoredAsUnchanged(t *testing.T) {
	t.Parallel()

	clock := newPollClock()
	src := newBatchSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{pendingPR("alrayyes/a", 1)})
	src.answer = failedAnswer
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())
	src.failRepoFetches(errors.New("outage"))

	got := polledMinutes(t, agg, clock, func() int { return src.repoFetchCallCount("alrayyes/a") }, 4)

	assert.Equal(t, []int{0, 1, 2, 3}, got)
}

func TestAggregator_PollCI_APlainRepoRefreshThatFailsIsNotScoredAsUnchanged(t *testing.T) {
	t.Parallel()

	clock := newPollClock()
	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{pendingPR("alrayyes/a", 1)})
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())
	src.failRepoFetches(errors.New("outage"))

	got := polledMinutes(t, agg, clock, func() int { return src.repoFetchCallCount("alrayyes/a") }, 4)

	assert.Equal(t, []int{0, 1, 2, 3}, got)
}

func TestAggregator_PollCI_AnAliasThatKeepsFailingIsReadLessAndLessOften(t *testing.T) {
	t.Parallel()

	clock := newPollClock()
	src := newBatchSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{pendingPR("alrayyes/a", 1)})
	src.answer = failedAnswer
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())

	got := polledMinutes(t, agg, clock, func() int { return src.repoFetchCallCount("alrayyes/a") }, 8)

	assert.Equal(t, []int{0, 1, 3, 7}, got, "a repo query on every tick for a pull request that never answers works against the budget")
}

func armedPR(repo string, number int) dashboard.PullRequest {
	on := true

	return dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: repo, Number: number, CI: dashboard.CISuccess, HeadSHA: testSHA, AutoMergeEnabled: &on}
}

func TestAggregator_PollCI_AnArmedAutoMergePullRequestIsNeverBackedOff(t *testing.T) {
	t.Parallel()

	clock := newPollClock()
	src := newBatchSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{armedPR("alrayyes/a", 1)})
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())

	got := polledMinutes(t, agg, clock, src.batchCount, 6)

	assert.Equal(t, []int{0, 1, 2, 3, 4, 5}, got, "GitHub merges it on its own, so the board must notice within one interval")
}

func TestAggregator_PollCI_AnArmedPullRequestIsNotLeftToTheWebhookEvenWithPendingChecks(t *testing.T) {
	t.Parallel()

	src := healthyHookSource()
	pr := armedPR("alrayyes/a", 1)
	pr.CI = dashboard.CIPending
	src.byRepo["alrayyes/a"] = []dashboard.PullRequest{pr}
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())
	agg.RecordCheckDelivery(dashboard.ForgeGitHub, "alrayyes/a", testSHA)

	agg.PollCI(t.Context())

	assert.Equal(t, 1, src.batchCount())
}

func TestAggregator_PollCI_AWebhookChangeDuringThePollIsNotCreditedToIt(t *testing.T) {
	t.Parallel()

	clock := newPollClock()
	src := newBatchSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{pendingPR("alrayyes/a", 1)})
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())

	// Every poll reads the row as it was, while a webhook refresh lands a newer
	// one before the answer comes back.
	passed := 0
	src.answer = func(refs []dashboard.PullRequestRef) dashboard.PendingResult {
		var read dashboard.PullRequest
		for _, pr := range agg.Get().PullRequests {
			if pr.Number == refs[0].Number {
				read = pr
			}
		}
		passed++
		fresher := pendingPR("alrayyes/a", 1)
		fresher.Checks = dashboard.CheckCounts{Passed: passed}
		src.setRepo("alrayyes/a", []dashboard.PullRequest{fresher})
		agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")

		return dashboard.PendingResult{Pulls: []dashboard.PullRequest{read}}
	}

	got := polledMinutes(t, agg, clock, src.batchCount, 4)

	require.Len(t, agg.Get().PullRequests, 1)
	assert.Equal(t, 3, agg.Get().PullRequests[0].Checks.Passed, "the webhook's newer rows won; the older poll answer did not overwrite them")
	assert.Equal(t, []int{0, 1, 3}, got, "the poll itself saw nothing change, so it backs off")
}
