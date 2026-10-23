package dashboard_test

import (
	"context"
	"slices"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// probingSource is a Source that skips the repos in skip when the refresh
// allows it, the way the GitHub source does once its probe sees no change.
type probingSource struct {
	mu          sync.Mutex
	skip        []string
	incremental []bool
	title       string
}

func (p *probingSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (p *probingSource) Fetch(ctx context.Context) dashboard.Result {
	p.mu.Lock()
	defer p.mu.Unlock()

	inc := dashboard.Incremental(ctx)
	p.incremental = append(p.incremental, inc)

	res := dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 2}}
	for _, name := range []string{"o/a", "o/b"} {
		res.Repos = append(res.Repos, dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: name})
		if inc && slices.Contains(p.skip, name) {
			res.Unchanged = append(res.Unchanged, name)

			continue
		}
		res.PullRequests = append(res.PullRequests, dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: name, Number: 1, Title: p.title})
		res.Issues = append(res.Issues, dashboard.Issue{Forge: dashboard.ForgeGitHub, Repo: name, Number: 2, Title: p.title})
		res.MainBranches = append(res.MainBranches, dashboard.MainBranch{Forge: dashboard.ForgeGitHub, FullName: name, Branch: p.title})
	}

	return res
}

func TestAggregator_Refresh_SkippedRepo_KeepsItsRowsWhole(t *testing.T) {
	t.Parallel()

	src := &probingSource{title: "old", skip: []string{"o/a"}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	agg.Refresh(t.Context()) // the first refresh is always a full pass
	src.title = "new"
	agg.Refresh(dashboard.BackgroundForTest(t.Context()))

	snap := agg.Get()
	titles := map[string]string{}
	for _, pr := range snap.PullRequests {
		titles[pr.Repo] = pr.Title
	}
	assert.Equal(t, map[string]string{"o/a": "old", "o/b": "new"}, titles, "the skipped repo keeps its pull request, the other is refetched")
	require.Len(t, snap.Issues, 2)
	require.Len(t, snap.MainBranches, 2)
	branches := map[string]string{}
	for _, b := range snap.MainBranches {
		branches[b.FullName] = b.Branch
	}
	assert.Equal(t, map[string]string{"o/a": "old", "o/b": "new"}, branches)
	assert.Len(t, snap.Repos, 2, "the Source's own repo rows stay, skipped or not")
}

func TestAggregator_Refresh_FullPassSchedule(t *testing.T) {
	t.Parallel()

	src := &probingSource{skip: []string{"o/a"}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	bg := dashboard.BackgroundForTest(t.Context())

	for range 7 {
		agg.Refresh(bg)
	}

	assert.Equal(t, []bool{false, true, true, true, true, true, false}, src.incremental,
		"the first refresh and every sixth are full passes")
}

func TestAggregator_Refresh_ForcedRefresh_IsAlwaysFull(t *testing.T) {
	t.Parallel()

	src := &probingSource{skip: []string{"o/a"}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	agg.Refresh(dashboard.BackgroundForTest(t.Context()))
	agg.Refresh(dashboard.BackgroundForTest(t.Context()))
	agg.Refresh(t.Context()) // a person's "Refresh now"

	assert.Equal(t, []bool{false, true, false}, src.incremental)
}
