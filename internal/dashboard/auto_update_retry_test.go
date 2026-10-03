package dashboard_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// refusingUpdater answers every update-branch call with err, and counts the
// calls. behind is what the forge currently reports for pull request 1.
type refusingUpdater struct {
	mu        sync.Mutex
	err       error
	calls     int
	behind    bool
	updatedAt time.Time
}

func (u *refusingUpdater) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (u *refusingUpdater) Fetch(context.Context) dashboard.Result {
	u.mu.Lock()
	defer u.mu.Unlock()

	return dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: u.behind, UpdatedAt: u.updatedAt},
		},
	}
}

func (u *refusingUpdater) UpdateBranch(context.Context, string, string, int) (bool, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.calls++

	return false, u.err
}

func (u *refusingUpdater) set(behind bool, updatedAt time.Time) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.behind, u.updatedAt = behind, updatedAt
}

func (u *refusingUpdater) callCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()

	return u.calls
}

func refresh(t *testing.T, agg *dashboard.Aggregator, times int) {
	t.Helper()
	for range times {
		agg.Refresh(t.Context())
	}
}

func newRetryAggregator(src *refusingUpdater) *dashboard.Aggregator {
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), &fakeAutoUpdateBranchLister{enabled: map[string]struct{}{"github/alrayyes/a": {}}})

	return agg
}

// An update-branch the forge refused is not tried again until the pull
// request changes (#895). Production logged the same conflicted pull request
// being retried about every two seconds, a call and a log line per refresh.
func TestAggregator_AutoUpdateBranch_ARefusedUpdateIsNotRetried(t *testing.T) {
	t.Parallel()

	t.Run("a merge conflict is tried once while the pull request is unchanged", func(t *testing.T) {
		t.Parallel()
		stamp := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
		src := &refusingUpdater{behind: true, updatedAt: stamp, err: &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("merge conflict between base and head")}}

		refresh(t, newRetryAggregator(src), 5)

		assert.Equal(t, 1, src.callCount())
	})

	t.Run("any other failure also waits instead of retrying on every refresh", func(t *testing.T) {
		t.Parallel()
		src := &refusingUpdater{behind: true, err: &dashboard.ClientError{Kind: dashboard.ForgeErrorUnreachable, Err: errors.New("timeout")}}

		refresh(t, newRetryAggregator(src), 5)

		assert.Equal(t, 1, src.callCount())
	})

	t.Run("a pull request that changed is tried again", func(t *testing.T) {
		t.Parallel()
		stamp := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
		src := &refusingUpdater{behind: true, updatedAt: stamp, err: &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("conflict")}}
		agg := newRetryAggregator(src)
		refresh(t, agg, 2)

		src.set(true, stamp.Add(time.Minute))
		refresh(t, agg, 2)

		assert.Equal(t, 2, src.callCount())
	})

	t.Run("a pull request that stopped being behind is forgotten, so behind again is tried again", func(t *testing.T) {
		t.Parallel()
		stamp := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
		src := &refusingUpdater{behind: true, updatedAt: stamp, err: &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("conflict")}}
		agg := newRetryAggregator(src)
		refresh(t, agg, 2)

		src.set(false, stamp)
		refresh(t, agg, 1)
		src.set(true, stamp)
		refresh(t, agg, 1)

		assert.Equal(t, 2, src.callCount())
	})

	t.Run("a success is not remembered as a failure", func(t *testing.T) {
		t.Parallel()
		src := &refusingUpdater{behind: true} // err nil: the update worked
		agg := newRetryAggregator(src)

		refresh(t, agg, 3)

		assert.Equal(t, 3, src.callCount(), "still behind after a success means something moved it again; ask each time as before")
	})
}
