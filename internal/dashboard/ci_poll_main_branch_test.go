package dashboard_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// forgejoBranchSource is a Forgejo RepoRefresher whose default-branch row can
// change between the full poll and a later read, as a manual rerun changes it.
type forgejoBranchSource struct {
	*fakeRepoRefresherSource

	mu      sync.Mutex
	polled  dashboard.MainBranch
	current dashboard.MainBranch
	reads   int
}

func newForgejoBranchSource(polled, current dashboard.MainBranch) *forgejoBranchSource {
	base := newFakeRepoRefresherSource()
	base.forge = dashboard.ForgeForgejo
	base.setRepo("o/a", nil)
	polled.Forge, polled.FullName, polled.FailingJobs = dashboard.ForgeForgejo, "o/a", []string{}
	current.Forge, current.FullName, current.FailingJobs = dashboard.ForgeForgejo, "o/a", []string{}

	return &forgejoBranchSource{fakeRepoRefresherSource: base, polled: polled, current: current}
}

func (s *forgejoBranchSource) Fetch(ctx context.Context) dashboard.Result {
	result := s.fakeRepoRefresherSource.Fetch(ctx)
	result.MainBranches = []dashboard.MainBranch{s.polled}

	return result
}

func (s *forgejoBranchSource) FetchMainBranch(context.Context, string, string, string) (dashboard.MainBranch, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads++

	return s.current, nil
}

func (s *forgejoBranchSource) branchReads() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.reads
}

// A rerun started on the forge sends no webhook until it ends, so a row read
// while the rerun was going stayed on that read: failed jobs from the attempt
// before beside the new attempt's running ones, while the dialog, read live,
// showed the rerun's real jobs. PollCI reads a running default branch again.
func TestAggregator_PollCI_RereadsARunningForgejoDefaultBranch(t *testing.T) {
	t.Parallel()

	src := newForgejoBranchSource(
		dashboard.MainBranch{Status: dashboard.MainBranchRunning, Checks: dashboard.CheckCounts{Failed: 6, Running: 4, Waiting: 1}},
		dashboard.MainBranch{Status: dashboard.MainBranchRunning, Checks: dashboard.CheckCounts{Passed: 1, Failed: 1, Running: 2, Waiting: 13}},
	)
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	require.Equal(t, 6, agg.Get().MainBranches[0].Checks.Failed)

	agg.PollCI(t.Context())

	assert.Equal(t, 13, agg.Get().MainBranches[0].Checks.Waiting)
}

// mainBranchStatus ranks a failed job above a running one, so a rerun that has
// jobs going and jobs failed reads as failed. That row still has work in
// flight, and is the one #2691 reported.
func TestAggregator_PollCI_RereadsAFailedForgejoDefaultBranchWithJobsStillGoing(t *testing.T) {
	t.Parallel()

	src := newForgejoBranchSource(
		dashboard.MainBranch{Status: dashboard.MainBranchFailed, Checks: dashboard.CheckCounts{Passed: 2, Failed: 6, Running: 4, Waiting: 1}},
		dashboard.MainBranch{Status: dashboard.MainBranchFailed, Checks: dashboard.CheckCounts{Passed: 1, Failed: 1, Running: 2, Waiting: 13}},
	)
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, 13, agg.Get().MainBranches[0].Checks.Waiting)
}

// A row that reads the same after a poll waits longer before the next, as a
// pending pull request does, so a long run is not hammered.
func TestAggregator_PollCI_BacksOffARunningForgejoDefaultBranchThatDoesNotChange(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	same := dashboard.MainBranch{Status: dashboard.MainBranchRunning, Checks: dashboard.CheckCounts{Running: 2}}
	src := newForgejoBranchSource(same, same)
	agg := dashboard.NewAggregator([]dashboard.Source{src},
		dashboard.WithCIPollInterval(time.Minute), dashboard.WithClock(func() time.Time { return now }))
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())
	now = now.Add(time.Minute)
	agg.PollCI(t.Context())
	now = now.Add(time.Minute)
	agg.PollCI(t.Context())

	assert.Equal(t, 2, src.branchReads(), "reads at 0m and 1m, then waits two minutes")
}

// A default branch that is not running has nothing a poll could change.
func TestAggregator_PollCI_LeavesAFinishedForgejoDefaultBranchAlone(t *testing.T) {
	t.Parallel()

	src := newForgejoBranchSource(
		dashboard.MainBranch{Status: dashboard.MainBranchFailed},
		dashboard.MainBranch{Status: dashboard.MainBranchPassed},
	)
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, 0, src.branchReads())
}

// GitHub tells the board of a finished check by webhook, so its rows are left to it.
func TestAggregator_PollCI_LeavesAGitHubDefaultBranchAlone(t *testing.T) {
	t.Parallel()

	src := newBranchRefreshingSource()
	src.polled = map[string]dashboard.MainBranchStatus{"alrayyes/a": dashboard.MainBranchRunning}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, 0, src.repoFetchCallCount("alrayyes/a"))
}
