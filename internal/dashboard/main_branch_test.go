package dashboard_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// branchSource serves one forge's default-branch rows and can be told to
// fail the way a rate limit or a timeout makes a real fetch return nothing.
type branchSource struct {
	forge dashboard.Forge
	mu    sync.Mutex
	rows  []dashboard.MainBranch
	down  bool
	calls int
}

func (s *branchSource) Forge() dashboard.Forge { return s.forge }

func (s *branchSource) Fetch(context.Context) dashboard.Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.down {
		return dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.forge, Reachable: false, Error: "rate limited"}}
	}

	return dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: s.forge, Reachable: true},
		MainBranches: append([]dashboard.MainBranch(nil), s.rows...),
	}
}

func (s *branchSource) set(down bool, rows ...dashboard.MainBranch) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.down, s.rows = down, rows
}

func row(forge dashboard.Forge, repo string, status dashboard.MainBranchStatus) dashboard.MainBranch {
	return dashboard.MainBranch{Forge: forge, FullName: repo, Branch: "main", Status: status, FailingJobs: []string{}}
}

func rowFor(snap dashboard.Snapshot, repo string) (dashboard.MainBranch, bool) {
	for _, r := range snap.MainBranches {
		if r.FullName == repo {
			return r, true
		}
	}

	return dashboard.MainBranch{}, false
}

func TestAggregator_MainBranches(t *testing.T) {
	t.Parallel()

	t.Run("an empty snapshot holds a list, not null", func(t *testing.T) {
		t.Parallel()

		assert.NotNil(t, dashboard.NewAggregator(nil).Get().MainBranches)
	})

	t.Run("a refresh puts every forge's rows in the snapshot", func(t *testing.T) {
		t.Parallel()
		gh := &branchSource{forge: dashboard.ForgeGitHub, rows: []dashboard.MainBranch{row(dashboard.ForgeGitHub, "o/a", dashboard.MainBranchFailed)}}
		fj := &branchSource{forge: dashboard.ForgeForgejo, rows: []dashboard.MainBranch{row(dashboard.ForgeForgejo, "o/b", dashboard.MainBranchPassed)}}
		agg := dashboard.NewAggregator([]dashboard.Source{gh, fj})

		agg.Refresh(t.Context())

		assert.Len(t, agg.Get().MainBranches, 2)
	})

	t.Run("an unreachable forge keeps its last rows, marked stale", func(t *testing.T) {
		t.Parallel()
		src := &branchSource{forge: dashboard.ForgeGitHub, rows: []dashboard.MainBranch{row(dashboard.ForgeGitHub, "o/a", dashboard.MainBranchFailed)}}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())
		src.set(true)

		agg.Refresh(t.Context())

		got, ok := rowFor(agg.Get(), "o/a")
		require.True(t, ok, "the row is still listed")
		assert.Equal(t, dashboard.MainBranchFailed, got.Status, "with the status it last had")
		assert.NotNil(t, got.StaleSince, "and says it is out of date")
	})

	t.Run("a row carried over twice keeps the time it was really fetched", func(t *testing.T) {
		t.Parallel()
		src := &branchSource{forge: dashboard.ForgeGitHub, rows: []dashboard.MainBranch{row(dashboard.ForgeGitHub, "o/a", dashboard.MainBranchPassed)}}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())
		src.set(true)
		agg.Refresh(t.Context())
		first, _ := rowFor(agg.Get(), "o/a")

		agg.Refresh(t.Context())

		again, _ := rowFor(agg.Get(), "o/a")
		assert.Equal(t, first.StaleSince, again.StaleSince)
	})

	t.Run("a good refresh replaces the rows and clears the mark", func(t *testing.T) {
		t.Parallel()
		src := &branchSource{forge: dashboard.ForgeGitHub, rows: []dashboard.MainBranch{row(dashboard.ForgeGitHub, "o/a", dashboard.MainBranchFailed)}}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())
		src.set(true)
		agg.Refresh(t.Context())

		src.set(false, row(dashboard.ForgeGitHub, "o/a", dashboard.MainBranchPassed))
		agg.Refresh(t.Context())

		got, _ := rowFor(agg.Get(), "o/a")
		assert.Equal(t, dashboard.MainBranchPassed, got.Status)
		assert.Nil(t, got.StaleSince)
	})

	t.Run("only the failed forge's rows are carried over", func(t *testing.T) {
		t.Parallel()
		gh := &branchSource{forge: dashboard.ForgeGitHub, rows: []dashboard.MainBranch{row(dashboard.ForgeGitHub, "o/a", dashboard.MainBranchFailed)}}
		fj := &branchSource{forge: dashboard.ForgeForgejo, rows: []dashboard.MainBranch{row(dashboard.ForgeForgejo, "o/b", dashboard.MainBranchFailed)}}
		agg := dashboard.NewAggregator([]dashboard.Source{gh, fj})
		agg.Refresh(t.Context())

		gh.set(true)
		fj.set(false, row(dashboard.ForgeForgejo, "o/b", dashboard.MainBranchPassed))
		agg.Refresh(t.Context())

		a, _ := rowFor(agg.Get(), "o/a")
		b, _ := rowFor(agg.Get(), "o/b")
		assert.NotNil(t, a.StaleSince, "GitHub's is the old one")
		assert.Nil(t, b.StaleSince, "Forgejo's is fresh")
		assert.Equal(t, dashboard.MainBranchPassed, b.Status)
	})

	t.Run("a forge with its budget spent is not called, and its rows are kept stale", func(t *testing.T) {
		t.Parallel()
		src := &exhaustedBranchSource{
			forge: dashboard.ForgeGitHub,
			rows:  []dashboard.MainBranch{row(dashboard.ForgeGitHub, "o/a", dashboard.MainBranchFailed)},
		}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())

		agg.Refresh(t.Context())

		got, ok := rowFor(agg.Get(), "o/a")
		require.True(t, ok)
		assert.Equal(t, 1, src.calls, "the second refresh spent nothing on it")
		assert.NotNil(t, got.StaleSince)
	})

	t.Run("a scoped refresh leaves them alone", func(t *testing.T) {
		t.Parallel()
		src := &scopedBranchSource{fakeRepoRefresherSource: newFakeRepoRefresherSource(), row: row(dashboard.ForgeGitHub, "o/a", dashboard.MainBranchFailed)}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())

		agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "o", "a", "o/a")

		_, ok := rowFor(agg.Get(), "o/a")
		assert.True(t, ok)
	})
}

// exhaustedBranchSource reports a spent GraphQL budget that resets in an hour.
type exhaustedBranchSource struct{ branchSource }

func (s *exhaustedBranchSource) Fetch(ctx context.Context) dashboard.Result {
	res := s.branchSource.Fetch(ctx)
	res.Health.RateLimitGraphQL = &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: time.Now().Add(time.Hour)}

	return res
}

// scopedBranchSource is a source that also refreshes a single repo.
type scopedBranchSource struct {
	*fakeRepoRefresherSource
	row dashboard.MainBranch
}

func (s *scopedBranchSource) Fetch(ctx context.Context) dashboard.Result {
	res := s.fakeRepoRefresherSource.Fetch(ctx)
	res.MainBranches = []dashboard.MainBranch{s.row}

	return res
}

// A repo whose default-branch read failed while its forge answered keeps the
// row it had, marked stale; the repo next to it is current.
func TestGenericSource_MainBranches(t *testing.T) {
	t.Parallel()

	t.Run("a reader's answer becomes a row of the repo", func(t *testing.T) {
		t.Parallel()
		client := &branchClient{
			repos:   []dashboard.RepoRef{{FullName: "o/a", Owner: "o", Name: "a", URL: "https://f/o/a", DefaultBranch: "trunk"}},
			answers: map[string]dashboard.MainBranch{"o/a": {Branch: "trunk", Status: dashboard.MainBranchFailed}},
		}

		res := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 2).Fetch(t.Context())

		require.Len(t, res.MainBranches, 1)
		got := res.MainBranches[0]
		assert.Equal(t, dashboard.ForgeForgejo, got.Forge)
		assert.Equal(t, "o/a", got.FullName)
		assert.Equal(t, "https://f/o/a", got.URL)
		assert.Equal(t, dashboard.MainBranchFailed, got.Status)
		assert.NotNil(t, got.FailingJobs, "an array, never null")
	})

	t.Run("a client with no reader gives no rows", func(t *testing.T) {
		t.Parallel()
		client := &fakeForgeClient{repos: []dashboard.RepoRef{{FullName: "o/a", Owner: "o", Name: "a"}}}

		res := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 2).Fetch(t.Context())

		assert.Empty(t, res.MainBranches)
	})

	t.Run("a failed read is named as failed, not dropped from the answer", func(t *testing.T) {
		t.Parallel()
		client := &branchClient{
			repos:   []dashboard.RepoRef{{FullName: "o/a", Owner: "o", Name: "a"}, {FullName: "o/b", Owner: "o", Name: "b"}},
			answers: map[string]dashboard.MainBranch{"o/b": {Status: dashboard.MainBranchPassed}},
			failing: map[string]bool{"o/a": true},
		}

		res := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 2).Fetch(t.Context())

		assert.Len(t, res.MainBranches, 1)
		assert.Equal(t, []dashboard.FailedRepo{{FullName: "o/a", MainBranch: true}}, res.FailedRepos)
	})
}

type branchClient struct {
	fakeForgeClient
	answers map[string]dashboard.MainBranch
	failing map[string]bool
}

func (c *branchClient) ReadMainBranch(_ context.Context, repo dashboard.RepoRef) (dashboard.MainBranch, error) {
	if c.failing[repo.FullName] {
		return dashboard.MainBranch{}, errors.New("timeout")
	}

	return c.answers[repo.FullName], nil
}

func TestAggregator_AFailedMainBranchReadKeepsThatRepoStale(t *testing.T) {
	t.Parallel()
	client := &branchClient{
		repos: []dashboard.RepoRef{{FullName: "o/a", Owner: "o", Name: "a"}, {FullName: "o/b", Owner: "o", Name: "b"}},
		answers: map[string]dashboard.MainBranch{
			"o/a": {Status: dashboard.MainBranchFailed},
			"o/b": {Status: dashboard.MainBranchFailed},
		},
	}
	agg := dashboard.NewAggregator([]dashboard.Source{dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 2)})
	agg.Refresh(t.Context())
	client.failing = map[string]bool{"o/a": true}
	client.answers["o/b"] = dashboard.MainBranch{Status: dashboard.MainBranchPassed}

	agg.Refresh(t.Context())

	a, _ := rowFor(agg.Get(), "o/a")
	b, _ := rowFor(agg.Get(), "o/b")
	assert.Equal(t, dashboard.MainBranchFailed, a.Status)
	assert.NotNil(t, a.StaleSince, "kept from the earlier refresh")
	assert.Equal(t, dashboard.MainBranchPassed, b.Status)
	assert.Nil(t, b.StaleSince)
}

func TestMainBranches_CountSortAndShortSHA(t *testing.T) {
	t.Parallel()
	rows := []dashboard.MainBranch{
		row(dashboard.ForgeGitHub, "o/d", dashboard.MainBranchNone),
		row(dashboard.ForgeGitHub, "o/c", dashboard.MainBranchPassed),
		row(dashboard.ForgeForgejo, "o/b", dashboard.MainBranchRunning),
		row(dashboard.ForgeGitHub, "o/z", dashboard.MainBranchFailed),
		row(dashboard.ForgeGitHub, "o/a", dashboard.MainBranchFailed),
	}

	t.Run("counts add up to the total", func(t *testing.T) {
		t.Parallel()

		assert.Equal(t, dashboard.MainBranchCounts{Failed: 2, Passed: 1, Running: 1, None: 1, Total: 5}, dashboard.CountMainBranches(rows))
	})

	t.Run("newest commit first whatever the status, undated rows last", func(t *testing.T) {
		t.Parallel()
		at := func(r dashboard.MainBranch, ts string) dashboard.MainBranch {
			c := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
			if ts != "" {
				d, _ := time.ParseDuration(ts)
				c = c.Add(d)
			}
			r.Commit = &dashboard.MainBranchCommit{CommittedAt: &c}

			return r
		}
		undatedCommit := row(dashboard.ForgeGitHub, "o/c", dashboard.MainBranchPassed)
		undatedCommit.Commit = &dashboard.MainBranchCommit{}
		sorted := []dashboard.MainBranch{
			row(dashboard.ForgeGitHub, "o/d", dashboard.MainBranchNone),
			undatedCommit,
			at(row(dashboard.ForgeGitHub, "o/old-failed", dashboard.MainBranchFailed), "1h"),
			at(row(dashboard.ForgeGitHub, "o/new-passed", dashboard.MainBranchPassed), "48h"),
			at(row(dashboard.ForgeForgejo, "o/tie", dashboard.MainBranchRunning), "24h"),
			at(row(dashboard.ForgeGitHub, "o/tie", dashboard.MainBranchFailed), "24h"),
			at(row(dashboard.ForgeGitHub, "o/a-tie", dashboard.MainBranchPassed), "24h"),
		}

		dashboard.SortMainBranches(sorted)

		var names []string
		for _, r := range sorted {
			names = append(names, string(r.Forge)+":"+r.FullName)
		}
		assert.Equal(t, []string{
			"github:o/new-passed", "github:o/a-tie", "forgejo:o/tie", "github:o/tie",
			"github:o/old-failed", "github:o/c", "github:o/d",
		}, names)
	})

	t.Run("a commit id is cut to seven characters", func(t *testing.T) {
		t.Parallel()

		assert.Equal(t, "0123456", dashboard.ShortSHA("0123456789abcdef"))
		assert.Equal(t, "abc", dashboard.ShortSHA("abc"))
	})

	t.Run("a combined CI result maps onto a status", func(t *testing.T) {
		t.Parallel()

		assert.Equal(t, dashboard.MainBranchFailed, dashboard.MainBranchStatusOfCI(dashboard.CIFailure))
		assert.Equal(t, dashboard.MainBranchPassed, dashboard.MainBranchStatusOfCI(dashboard.CISuccess))
		assert.Equal(t, dashboard.MainBranchRunning, dashboard.MainBranchStatusOfCI(dashboard.CIPending))
		assert.Equal(t, dashboard.MainBranchNone, dashboard.MainBranchStatusOfCI(dashboard.CINone))
	})
}
