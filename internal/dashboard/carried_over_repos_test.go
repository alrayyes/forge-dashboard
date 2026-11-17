package dashboard_test

import (
	"context"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// twoReposSource serves repos o/a and o/b and can be told to fail its full
// fetch, as a failed repo discovery does, while a one-repo fetch still works.
type twoReposSource struct {
	forge dashboard.Forge
	mu    sync.Mutex
	down  bool
}

func (s *twoReposSource) Forge() dashboard.Forge { return s.forge }

func (s *twoReposSource) goDown() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.down = true
}

func (s *twoReposSource) Fetch(context.Context) dashboard.Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down {
		return dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.forge, Reachable: false, Error: "discovery failed", ErrorKind: dashboard.ForgeErrorUnreachable}}
	}

	return dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: s.forge, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: s.forge, Repo: "o/a", Number: 1},
			{Forge: s.forge, Repo: "o/b", Number: 2},
		},
		Repos: []dashboard.Repo{{Forge: s.forge, FullName: "o/a"}, {Forge: s.forge, FullName: "o/b"}},
	}
}

func (s *twoReposSource) FetchRepo(_ context.Context, _, _, fullName string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	return []dashboard.PullRequest{{Forge: s.forge, Repo: fullName, Number: 9}}, nil, nil
}

// A full refresh that fails carries every repo over, and each repo says so, so
// the page can tell which rows are old without reading the forge's health
// (#3869).
func TestAggregator_AFailedFullRefreshMarksEveryCarriedOverRepo(t *testing.T) {
	t.Parallel()
	src := &twoReposSource{forge: dashboard.ForgeGitHub}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	src.goDown()
	agg.Refresh(t.Context())

	snap := agg.Get()
	require.NotNil(t, repoNamed(t, agg, "o/a").StaleSince)
	require.NotNil(t, repoNamed(t, agg, "o/b").StaleSince)
	assert.Equal(t, health(snap, dashboard.ForgeGitHub).StaleSince, repoNamed(t, agg, "o/a").StaleSince)
}

// While full refreshes keep failing, a webhook's refresh of one repo makes that
// repo current. The forge stays marked while another repo still holds only
// carried-over rows, and the repo that was refreshed has no mark (#3869).
func TestAggregator_AScopedRefreshWhileFullRefreshesFail(t *testing.T) {
	t.Parallel()

	t.Run("the refreshed repo is current and the other stays marked", func(t *testing.T) {
		t.Parallel()
		src := &twoReposSource{forge: dashboard.ForgeGitHub}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())
		src.goDown()
		agg.Refresh(t.Context())

		require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "o", "a", "o/a"))

		snap := agg.Get()
		assert.Nil(t, repoNamed(t, agg, "o/a").StaleSince)
		assert.NotNil(t, repoNamed(t, agg, "o/b").StaleSince)
		h := health(snap, dashboard.ForgeGitHub)
		assert.False(t, h.Reachable, "o/b still holds only old rows")
		assert.NotNil(t, h.StaleSince)
	})

	t.Run("the forge shows as reachable once every repo has been refreshed", func(t *testing.T) {
		t.Parallel()
		src := &twoReposSource{forge: dashboard.ForgeGitHub}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())
		src.goDown()
		agg.Refresh(t.Context())

		require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "o", "a", "o/a"))
		require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "o", "b", "o/b"))

		h := health(agg.Get(), dashboard.ForgeGitHub)
		assert.True(t, h.Reachable)
		assert.Nil(t, h.StaleSince)
		assert.Empty(t, h.Error)
		assert.Empty(t, h.ErrorKind)
	})

	t.Run("a repo a webhook refreshed stays current through the next failed full refresh", func(t *testing.T) {
		t.Parallel()
		src := &twoReposSource{forge: dashboard.ForgeGitHub}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())
		src.goDown()
		agg.Refresh(t.Context())
		require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "o", "a", "o/a"))

		agg.Refresh(t.Context())

		assert.Nil(t, repoNamed(t, agg, "o/a").StaleSince)
		assert.NotNil(t, repoNamed(t, agg, "o/b").StaleSince)
	})
}

// A full refresh that fails says why in the server log, so a report of old rows
// can be traced to a cause without catching the next failure live (#3869).
func TestAggregator_AFailedFullRefreshLogsItsCause(t *testing.T) {
	logs := withCapturedLogs(t)
	src := &fakeSource{result: dashboard.Result{Health: dashboard.ForgeHealth{
		Forge: dashboard.ForgeGitHub, Reachable: false,
		Error: "rate limited", ErrorKind: dashboard.ForgeErrorRateLimited,
	}}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	agg.Refresh(t.Context())

	logged := logs.String()
	assert.Contains(t, logged, "full refresh failed")
	assert.Contains(t, logged, "forge=github")
	assert.Contains(t, logged, "cause=rate_limited")
}
