package dashboard_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// branchRefreshingSource is a RepoRefresher that also re-reads one repo's
// default branch (#1316): Fetch answers the rows as they were at the last full
// poll, FetchMainBranch the rows as they are now.
type branchRefreshingSource struct {
	*fakeRepoRefresherSource

	mu      sync.Mutex
	polled  map[string]dashboard.MainBranchStatus
	current map[string]dashboard.MainBranchStatus
	err     error
}

func (s *branchRefreshingSource) Fetch(ctx context.Context) dashboard.Result {
	result := s.fakeRepoRefresherSource.Fetch(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	for name, status := range s.polled {
		result.MainBranches = append(result.MainBranches, dashboard.MainBranch{
			Forge: dashboard.ForgeGitHub, FullName: name, Branch: "main", Status: status, FailingJobs: []string{},
		})
	}

	return result
}

func (s *branchRefreshingSource) FetchMainBranch(_ context.Context, _, _, fullName string) (dashboard.MainBranch, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return dashboard.MainBranch{}, s.err
	}

	return dashboard.MainBranch{
		Forge: dashboard.ForgeGitHub, FullName: fullName, Branch: "main", Status: s.current[fullName], FailingJobs: []string{},
	}, nil
}

func branchStatuses(snap dashboard.Snapshot) map[string]dashboard.MainBranchStatus {
	out := map[string]dashboard.MainBranchStatus{}
	for _, b := range snap.MainBranches {
		out[b.FullName] = b.Status
	}

	return out
}

func newBranchRefreshingSource() *branchRefreshingSource {
	src := &branchRefreshingSource{
		fakeRepoRefresherSource: newFakeRepoRefresherSource(),
		polled: map[string]dashboard.MainBranchStatus{
			"alrayyes/a": dashboard.MainBranchFailed,
			"alrayyes/b": dashboard.MainBranchFailed,
		},
		current: map[string]dashboard.MainBranchStatus{
			"alrayyes/a": dashboard.MainBranchPassed,
			"alrayyes/b": dashboard.MainBranchPassed,
		},
	}
	src.setRepo("alrayyes/a", nil)
	src.setRepo("alrayyes/b", nil)

	return src
}

func TestAggregator_RefreshRepo_RereadsOnlyTheNamedReposDefaultBranch(t *testing.T) {
	t.Parallel()

	src := newBranchRefreshingSource()
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	require.Equal(t, dashboard.MainBranchFailed, branchStatuses(agg.Get())["alrayyes/a"])

	require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a"))

	got := branchStatuses(agg.Get())
	assert.Equal(t, dashboard.MainBranchPassed, got["alrayyes/a"], "the rerun passed, so the row turns green on the webhook")
	assert.Equal(t, dashboard.MainBranchFailed, got["alrayyes/b"], "another repo's row waits for its own delivery")
}

func TestAggregator_RefreshRepo_KeepsTheOldRowWhenTheBranchReadFails(t *testing.T) {
	t.Parallel()

	src := newBranchRefreshingSource()
	src.err = errors.New("boom")
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a"))

	assert.Equal(t, dashboard.MainBranchFailed, branchStatuses(agg.Get())["alrayyes/a"])
}
