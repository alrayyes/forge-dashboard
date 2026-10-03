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

// listingSource serves whatever pull requests it is told to, so a test can
// play a forge that goes on listing a merged pull request for a while.
type listingSource struct {
	mu  sync.Mutex
	prs []dashboard.PullRequest
}

func (s *listingSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (s *listingSource) Fetch(context.Context) dashboard.Result {
	s.mu.Lock()
	defer s.mu.Unlock()

	return dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: append([]dashboard.PullRequest(nil), s.prs...),
	}
}

func (s *listingSource) list(numbers ...int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prs = nil
	for _, n := range numbers {
		s.prs = append(s.prs, dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: n})
	}
}

func numbers(snap dashboard.Snapshot) []int {
	out := []int{}
	for _, pr := range snap.PullRequests {
		out = append(out, pr.Number)
	}

	return out
}

// Once the server knows a merge or close succeeded it stops listing that pull
// request itself (#835), so a forge that still reports it open for a few
// seconds can't leave the row on the board.
func TestAggregator_MarkSettled(t *testing.T) {
	t.Parallel()

	t.Run("drops the pull request at once and keeps the others", func(t *testing.T) {
		t.Parallel()
		src := &listingSource{}
		src.list(1, 2)
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())

		agg.MarkSettled(dashboard.ForgeGitHub, "o/r", 1)

		assert.ElementsMatch(t, []int{2}, numbers(agg.Get()))
	})

	t.Run("keeps it out while the forge still lists it", func(t *testing.T) {
		t.Parallel()
		src := &listingSource{}
		src.list(1, 2)
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())
		agg.MarkSettled(dashboard.ForgeGitHub, "o/r", 1)

		agg.Refresh(t.Context())

		assert.ElementsMatch(t, []int{2}, numbers(agg.Get()))
	})

	t.Run("tells subscribers at once", func(t *testing.T) {
		t.Parallel()
		src := &listingSource{}
		src.list(1, 2)
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())
		ch, unsubscribe := agg.Subscribe()
		defer unsubscribe()

		agg.MarkSettled(dashboard.ForgeGitHub, "o/r", 1)

		select {
		case snap := <-ch:
			assert.ElementsMatch(t, []int{2}, numbers(snap))
		case <-time.After(time.Second):
			t.Fatal("no snapshot pushed after MarkSettled")
		}
	})

	t.Run("forgets it once the forge stops listing it, so a reopened one shows", func(t *testing.T) {
		t.Parallel()
		src := &listingSource{}
		src.list(1, 2)
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())
		agg.MarkSettled(dashboard.ForgeGitHub, "o/r", 1)
		src.list(2)
		agg.Refresh(t.Context())

		src.list(1, 2)
		agg.Refresh(t.Context())

		assert.ElementsMatch(t, []int{1, 2}, numbers(agg.Get()))
	})

	t.Run("brings it back if it is still open after the settle window", func(t *testing.T) {
		t.Parallel()
		src := &listingSource{}
		src.list(1)
		agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithSettleWindow(30*time.Millisecond))
		agg.Refresh(t.Context())
		agg.MarkSettled(dashboard.ForgeGitHub, "o/r", 1)

		require.Eventually(t, func() bool {
			agg.Refresh(t.Context())

			return len(agg.Get().PullRequests) == 1
		}, time.Second, 20*time.Millisecond, "a pull request still open long after a merge must show again")
	})

	t.Run("another repo's pull request with the same number stays", func(t *testing.T) {
		t.Parallel()
		src := &listingSource{}
		src.list(1)
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())

		agg.MarkSettled(dashboard.ForgeGitHub, "other/repo", 1)

		assert.ElementsMatch(t, []int{1}, numbers(agg.Get()))
	})
}
