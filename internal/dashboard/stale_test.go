package dashboard_test

import (
	"context"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// flakySource serves one forge and can be told to fail, the way a rate limit,
// a timeout or a GraphQL error makes a real fetch return nothing (#922).
type flakySource struct {
	forge dashboard.Forge
	mu    sync.Mutex
	prs   []int
	down  bool
}

func (s *flakySource) Forge() dashboard.Forge { return s.forge }

func (s *flakySource) Fetch(context.Context) dashboard.Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down {
		return dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.forge, Reachable: false, Error: "rate limited"}}
	}
	res := dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.forge, Reachable: true}}
	for _, n := range s.prs {
		res.PullRequests = append(res.PullRequests, dashboard.PullRequest{Forge: s.forge, Repo: "o/r", Number: n})
	}
	res.Repos = []dashboard.Repo{{Forge: s.forge, FullName: "o/r"}}

	return res
}

func (s *flakySource) set(down bool, prs ...int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.down, s.prs = down, prs
}

func health(snap dashboard.Snapshot, forge dashboard.Forge) dashboard.ForgeHealth {
	for _, h := range snap.Forges {
		if h.Forge == forge {
			return h
		}
	}

	return dashboard.ForgeHealth{}
}

// A forge that fails a refresh keeps showing what it last showed, marked as
// out of date, instead of vanishing from the board (#922).
func TestAggregator_AFailedForgeKeepsItsLastGoodData(t *testing.T) {
	t.Parallel()

	t.Run("its pull requests and repos carry over, marked stale", func(t *testing.T) {
		t.Parallel()
		src := &flakySource{forge: dashboard.ForgeGitHub, prs: []int{1, 2}}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())

		src.set(true)
		agg.Refresh(t.Context())

		snap := agg.Get()
		assert.ElementsMatch(t, []int{1, 2}, numbers(snap))
		assert.Len(t, snap.Repos, 1)
		h := health(snap, dashboard.ForgeGitHub)
		assert.False(t, h.Reachable, "still reported unreachable")
		assert.Equal(t, "rate limited", h.Error)
		require.NotNil(t, h.StaleSince, "says when the data being shown was fetched")
	})

	t.Run("stays stamped with the original time across several failures", func(t *testing.T) {
		t.Parallel()
		src := &flakySource{forge: dashboard.ForgeGitHub, prs: []int{1}}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())
		src.set(true)
		agg.Refresh(t.Context())
		first := health(agg.Get(), dashboard.ForgeGitHub).StaleSince
		require.NotNil(t, first)

		agg.Refresh(t.Context())

		assert.Equal(t, first, health(agg.Get(), dashboard.ForgeGitHub).StaleSince)
	})

	t.Run("a good refresh replaces it and clears the mark", func(t *testing.T) {
		t.Parallel()
		src := &flakySource{forge: dashboard.ForgeGitHub, prs: []int{1, 2}}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())
		src.set(true)
		agg.Refresh(t.Context())

		src.set(false, 3)
		agg.Refresh(t.Context())

		snap := agg.Get()
		assert.ElementsMatch(t, []int{3}, numbers(snap))
		assert.Nil(t, health(snap, dashboard.ForgeGitHub).StaleSince)
		assert.True(t, health(snap, dashboard.ForgeGitHub).Reachable)
	})

	t.Run("a forge that never worked has nothing to carry over", func(t *testing.T) {
		t.Parallel()
		src := &flakySource{forge: dashboard.ForgeGitHub, down: true}
		agg := dashboard.NewAggregator([]dashboard.Source{src})

		agg.Refresh(t.Context())

		snap := agg.Get()
		assert.Empty(t, snap.PullRequests)
		assert.Nil(t, health(snap, dashboard.ForgeGitHub).StaleSince)
	})

	t.Run("only the failed forge is carried over", func(t *testing.T) {
		t.Parallel()
		gh := &flakySource{forge: dashboard.ForgeGitHub, prs: []int{1}}
		fj := &flakySource{forge: dashboard.ForgeForgejo, prs: []int{7}}
		agg := dashboard.NewAggregator([]dashboard.Source{gh, fj})
		agg.Refresh(t.Context())

		gh.set(true)
		fj.set(false, 8)
		agg.Refresh(t.Context())

		snap := agg.Get()
		assert.ElementsMatch(t, []int{1, 8}, numbers(snap), "GitHub's old #1, Forgejo's fresh #8, not Forgejo's old #7")
		assert.NotNil(t, health(snap, dashboard.ForgeGitHub).StaleSince)
		assert.Nil(t, health(snap, dashboard.ForgeForgejo).StaleSince)
	})

	t.Run("a pull request merged meanwhile stays off the board", func(t *testing.T) {
		t.Parallel()
		src := &flakySource{forge: dashboard.ForgeGitHub, prs: []int{1, 2}}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())
		agg.MarkSettled(dashboard.ForgeGitHub, "o/r", 1)

		src.set(true)
		agg.Refresh(t.Context())

		assert.ElementsMatch(t, []int{2}, numbers(agg.Get()))
	})
}
