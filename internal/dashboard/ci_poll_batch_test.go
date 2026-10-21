package dashboard_test

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// batchSource is a repo-refreshing source that can also answer many pull
// requests in one RefreshPending call, and report its hooks' events.
type batchSource struct {
	*fakeRepoRefresherSource

	bmu     sync.Mutex
	batches [][]dashboard.PullRequestRef
	// answer builds the reply for a batch; nil echoes the stored pull requests.
	answer func(refs []dashboard.PullRequestRef) dashboard.PendingResult
	// err, when set, makes RefreshPending fail as a whole.
	err   error
	hooks map[string][]string
}

func newBatchSource() *batchSource {
	return &batchSource{fakeRepoRefresherSource: newFakeRepoRefresherSource(), hooks: map[string][]string{}}
}

func (b *batchSource) RefreshPending(_ context.Context, refs []dashboard.PullRequestRef) (dashboard.PendingResult, error) {
	b.bmu.Lock()
	b.batches = append(b.batches, refs)
	b.bmu.Unlock()
	if b.err != nil {
		return dashboard.PendingResult{}, b.err
	}
	if b.answer != nil {
		return b.answer(refs), nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	var out dashboard.PendingResult
	for _, ref := range refs {
		for _, pr := range b.byRepo[ref.FullName] {
			if pr.Number == ref.Number {
				out.Pulls = append(out.Pulls, pr)
			}
		}
	}

	return out, nil
}

func (b *batchSource) WebhookEvents(fullName string) ([]string, bool) {
	events, ok := b.hooks[fullName]

	return events, ok
}

func (b *batchSource) batchCount() int {
	b.bmu.Lock()
	defer b.bmu.Unlock()

	return len(b.batches)
}

func (b *batchSource) lastBatch() []dashboard.PullRequestRef {
	b.bmu.Lock()
	defer b.bmu.Unlock()
	if len(b.batches) == 0 {
		return nil
	}

	return b.batches[len(b.batches)-1]
}

func pendingPR(repo string, number int) dashboard.PullRequest {
	return dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: repo, Number: number, CI: dashboard.CIPending, HeadSHA: testSHA}
}

func TestAggregator_PollCI_BatchesPendingPullRequestsInTwelveReposIntoOneCall(t *testing.T) {
	t.Parallel()

	src := newBatchSource()
	for i := range 12 {
		repo := fmt.Sprintf("alrayyes/r%d", i)
		src.setRepo(repo, []dashboard.PullRequest{pendingPR(repo, 1)})
	}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, 1, src.batchCount(), "one batched query, not one call per repo")
	assert.Len(t, src.lastBatch(), 12)
}

func TestAggregator_PollCI_BatchedPollMakesNoPerRepoCalls(t *testing.T) {
	t.Parallel()

	src := newBatchSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{pendingPR("alrayyes/a", 1)})
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, 0, src.repoFetchCallCount("alrayyes/a"))
}

func TestAggregator_PollCI_ArmedAutoMergeJoinsTheSameBatch(t *testing.T) {
	t.Parallel()

	on := true
	src := newBatchSource()
	src.setRepo("alrayyes/pending", []dashboard.PullRequest{pendingPR("alrayyes/pending", 1)})
	src.setRepo("alrayyes/armed", []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/armed", Number: 2, CI: dashboard.CISuccess, AutoMergeEnabled: &on},
	})
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, 1, src.batchCount(), "the auto-merge poll shares the CI poll's query")
	assert.Len(t, src.lastBatch(), 2)
}

func TestAggregator_PollCI_BatchedResultReplacesOnlyTheAskedAboutPullRequests(t *testing.T) {
	t.Parallel()

	src := newBatchSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{
		pendingPR("alrayyes/a", 1),
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, CI: dashboard.CISuccess, Title: "untouched"},
	})
	src.issues["alrayyes/a"] = []dashboard.Issue{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 9}}
	src.answer = func(_ []dashboard.PullRequestRef) dashboard.PendingResult {
		done := pendingPR("alrayyes/a", 1)
		done.CI = dashboard.CISuccess

		return dashboard.PendingResult{Pulls: []dashboard.PullRequest{done}}
	}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	snap := agg.Get()
	require.Len(t, snap.PullRequests, 2)
	byNumber := map[int]dashboard.PullRequest{}
	for _, pr := range snap.PullRequests {
		byNumber[pr.Number] = pr
	}
	assert.Equal(t, dashboard.CISuccess, byNumber[1].CI, "the polled pull request took its new state")
	assert.Equal(t, "untouched", byNumber[2].Title)
	assert.Len(t, snap.Issues, 1, "the repo's issues are not touched by a pending-check poll")
}

func TestAggregator_PollCI_PullRequestClosedMeanwhileLeavesTheBoard(t *testing.T) {
	t.Parallel()

	src := newBatchSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{pendingPR("alrayyes/a", 1)})
	src.answer = func(refs []dashboard.PullRequestRef) dashboard.PendingResult {
		return dashboard.PendingResult{Closed: refs}
	}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Empty(t, agg.Get().PullRequests)
}

func TestAggregator_PollCI_OneFailedAliasFallsBackToAPerRepoRefreshAndKeepsTheRest(t *testing.T) {
	t.Parallel()

	src := newBatchSource()
	src.setRepo("alrayyes/ok", []dashboard.PullRequest{pendingPR("alrayyes/ok", 1)})
	src.setRepo("alrayyes/bad", []dashboard.PullRequest{pendingPR("alrayyes/bad", 1)})
	src.answer = func(refs []dashboard.PullRequestRef) dashboard.PendingResult {
		var out dashboard.PendingResult
		for _, ref := range refs {
			if ref.FullName == "alrayyes/bad" {
				out.Failed = append(out.Failed, ref)

				continue
			}
			pr := pendingPR(ref.FullName, ref.Number)
			pr.CI = dashboard.CISuccess
			out.Pulls = append(out.Pulls, pr)
		}

		return out
	}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, 1, src.batchCount())
	assert.Equal(t, 1, src.repoFetchCallCount("alrayyes/bad"), "the failed alias is refreshed on its own")
	assert.Equal(t, 0, src.repoFetchCallCount("alrayyes/ok"), "the answered alias is not")
	for _, pr := range agg.Get().PullRequests {
		if pr.Repo == "alrayyes/ok" {
			assert.Equal(t, dashboard.CISuccess, pr.CI)
		}
	}
}

func TestAggregator_PollCI_SpentForgeMakesNoBatchedRequest(t *testing.T) {
	t.Parallel()

	src := newBatchSource()
	src.exhausted = true
	src.setRepo("alrayyes/a", []dashboard.PullRequest{pendingPR("alrayyes/a", 1)})
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, 0, src.batchCount())
}

// pollClock is a clock a test moves by hand.
type pollClock struct {
	mu  sync.Mutex
	now time.Time
}

func newPollClock() *pollClock {
	return &pollClock{now: time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)}
}

func (c *pollClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.now
}

func (c *pollClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

const pollBase = time.Minute

func TestAggregator_PollCI_UnchangedPullRequestIsPolledLessOftenUpToTheCap(t *testing.T) {
	t.Parallel()

	clock := newPollClock()
	src := newBatchSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{pendingPR("alrayyes/a", 1)})
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())

	// One tick per base interval for an hour; record the minutes it was polled.
	var polledAt []int
	for minute := range 61 {
		before := src.batchCount()
		agg.PollCI(t.Context())
		if src.batchCount() > before {
			polledAt = append(polledAt, minute)
		}
		clock.advance(pollBase)
	}

	// Gaps double: 1, 2, 4, 8, then the 15 minute cap.
	assert.Equal(t, []int{0, 1, 3, 7, 15, 30, 45, 60}, polledAt)
}

func TestAggregator_PollCI_ChangedPullRequestResetsItsInterval(t *testing.T) {
	t.Parallel()

	clock := newPollClock()
	src := newBatchSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{pendingPR("alrayyes/a", 1)})
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())

	// Let the interval grow: polls at minute 0, 1, 3.
	for range 4 {
		agg.PollCI(t.Context())
		clock.advance(pollBase)
	}
	grown := src.batchCount()
	require.Equal(t, 3, grown)

	// The next due poll (minute 7) sees a change.
	src.answer = func(refs []dashboard.PullRequestRef) dashboard.PendingResult {
		pr := pendingPR(refs[0].FullName, refs[0].Number)
		pr.Checks = dashboard.CheckCounts{Passed: 1}

		return dashboard.PendingResult{Pulls: []dashboard.PullRequest{pr}}
	}
	for range 4 {
		agg.PollCI(t.Context())
		clock.advance(pollBase)
	}
	require.Equal(t, grown+1, src.batchCount(), "polled once at minute 7")

	agg.PollCI(t.Context())

	assert.Equal(t, grown+2, src.batchCount(), "the change reset the interval, so the very next tick polls again")
}

const (
	hookEventsWithChecks = "check_run"
	testSHA              = "0123456789abcdef0123456789abcdef01234567"
	otherTestSHA         = "fedcba9876543210fedcba9876543210fedcba98"
)

func healthyHookSource() *batchSource {
	const repo = "alrayyes/a"
	src := newBatchSource()
	src.setRepo(repo, []dashboard.PullRequest{pendingPR(repo, 1)})
	src.hooks[repo] = []string{"pull_request", hookEventsWithChecks}

	return src
}

func TestAggregator_PollCI_SkipsARepoWhoseCheckDeliveriesAreOnTime(t *testing.T) {
	t.Parallel()

	clock := newPollClock()
	src := healthyHookSource()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())
	agg.RecordCheckDelivery(dashboard.ForgeGitHub, "alrayyes/a", testSHA)

	agg.PollCI(t.Context())

	assert.Equal(t, 0, src.batchCount())
}

func TestAggregator_PollCI_PollsARepoWhoseCheckDeliveryIsOverdue(t *testing.T) {
	t.Parallel()

	clock := newPollClock()
	src := healthyHookSource()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())
	agg.RecordCheckDelivery(dashboard.ForgeGitHub, "alrayyes/a", testSHA)
	clock.advance(3*pollBase + time.Second)

	agg.PollCI(t.Context())

	assert.Equal(t, 1, src.batchCount())
}

func TestAggregator_PollCI_CommentDeliveriesDoNotKeepARepoSkipped(t *testing.T) {
	t.Parallel()

	clock := newPollClock()
	src := healthyHookSource()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())
	agg.RecordDelivery(dashboard.ForgeGitHub, "alrayyes/a", "issue_comment")

	agg.PollCI(t.Context())

	assert.Equal(t, 1, src.batchCount())
}

func TestAggregator_PollCI_PollsARepoWithNoConfirmedHook(t *testing.T) {
	t.Parallel()

	src := healthyHookSource()
	delete(src.hooks, "alrayyes/a")
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())
	agg.RecordCheckDelivery(dashboard.ForgeGitHub, "alrayyes/a", testSHA)

	agg.PollCI(t.Context())

	assert.Equal(t, 1, src.batchCount())
}

func TestAggregator_PollCI_PollsARepoWhoseHookLacksCheckEvents(t *testing.T) {
	t.Parallel()

	src := healthyHookSource()
	src.hooks["alrayyes/a"] = []string{"pull_request", "issue_comment"}
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())
	agg.RecordCheckDelivery(dashboard.ForgeGitHub, "alrayyes/a", testSHA)

	agg.PollCI(t.Context())

	assert.Equal(t, 1, src.batchCount())
}

func TestAggregator_PollCI_ADeliveryForAnotherPullRequestsCommitDoesNotHideThisOne(t *testing.T) {
	t.Parallel()

	src := healthyHookSource()
	other := pendingPR("alrayyes/a", 2)
	other.HeadSHA = otherTestSHA
	src.byRepo["alrayyes/a"] = append(src.byRepo["alrayyes/a"], other)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())
	agg.RecordCheckDelivery(dashboard.ForgeGitHub, "alrayyes/a", testSHA)

	agg.PollCI(t.Context())

	require.Equal(t, 1, src.batchCount())
	refs := src.lastBatch()
	require.Len(t, refs, 1, "the pull request whose own delivery arrived is skipped, the other is not")
	assert.Equal(t, 2, refs[0].Number)
}

func TestAggregator_PollCI_PollsAPullRequestWithNoKnownHeadCommit(t *testing.T) {
	t.Parallel()

	src := healthyHookSource()
	noSHA := pendingPR("alrayyes/a", 1)
	noSHA.HeadSHA = ""
	src.byRepo["alrayyes/a"] = []dashboard.PullRequest{noSHA}
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())
	agg.RecordCheckDelivery(dashboard.ForgeGitHub, "alrayyes/a", testSHA)

	agg.PollCI(t.Context())

	assert.Equal(t, 1, src.batchCount())
}

func TestAggregator_PollCI_DeliveriesCannotHoldOffPollingBeyondTheCap(t *testing.T) {
	t.Parallel()

	clock := newPollClock()
	src := healthyHookSource()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())

	// A delivery for the commit arrives before every tick, as a replay would.
	var polledAt []int
	for minute := range 16 {
		agg.RecordCheckDelivery(dashboard.ForgeGitHub, "alrayyes/a", testSHA)
		before := src.batchCount()
		agg.PollCI(t.Context())
		if src.batchCount() > before {
			polledAt = append(polledAt, minute)
		}
		clock.advance(pollBase)
	}

	assert.Equal(t, []int{15}, polledAt, "skipped for the 15 minute cap, then read once")
}

func TestAggregator_PollCI_AnIntervalAboveTheCapIsNotBackedOffFurther(t *testing.T) {
	t.Parallel()

	const base = 20 * time.Minute
	clock := newPollClock()
	src := newBatchSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{pendingPR("alrayyes/a", 1)})
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithCIPollInterval(base))
	agg.Refresh(t.Context())

	for range 7 {
		agg.PollCI(t.Context())
		clock.advance(base)
	}

	assert.Equal(t, 7, src.batchCount(), "an unchanged pull request is still read every configured interval, not every other one")
}

func TestAggregator_PollCI_NeverSkipsAForgejoRepo(t *testing.T) {
	t.Parallel()

	src := healthyHookSource()
	src.forge = dashboard.ForgeForgejo
	src.byRepo["alrayyes/a"] = []dashboard.PullRequest{{Forge: dashboard.ForgeForgejo, Repo: "alrayyes/a", Number: 1, CI: dashboard.CIPending, HeadSHA: testSHA}}
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithCIPollInterval(pollBase))
	agg.Refresh(t.Context())
	agg.RecordCheckDelivery(dashboard.ForgeForgejo, "alrayyes/a", testSHA)

	agg.PollCI(t.Context())

	assert.Equal(t, 1, src.batchCount())
}
