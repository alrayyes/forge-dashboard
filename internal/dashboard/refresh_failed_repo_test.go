package dashboard_test

import (
	"context"
	"errors"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// flakyForgeClient answers every repo until told to fail some calls: a forge
// that is reachable but whose per-repo calls time out or hit a secondary
// limit now and then (#1194).
type flakyForgeClient struct {
	fakeForgeClient
	failPRs    map[string]bool
	failIssues map[string]bool
}

func (f *flakyForgeClient) ListOpenPullRequests(ctx context.Context, owner, name, repo string) ([]dashboard.PullRequest, error) {
	if f.failPRs[repo] {
		return nil, errors.New("timeout")
	}

	return f.fakeForgeClient.ListOpenPullRequests(ctx, owner, name, repo)
}

func (f *flakyForgeClient) ListOpenIssues(ctx context.Context, owner, name, repo string) ([]dashboard.Issue, error) {
	if f.failIssues[repo] {
		return nil, errors.New("timeout")
	}

	return f.fakeForgeClient.ListOpenIssues(ctx, owner, name, repo)
}

func twoRepoClient() *flakyForgeClient {
	base := fakeForgeClient{
		repos: []dashboard.RepoRef{
			{FullName: "o/a", Owner: "o", Name: "a"},
			{FullName: "o/b", Owner: "o", Name: "b"},
		},
		prsByRepo: map[string][]dashboard.PullRequest{
			"o/a": {{Forge: dashboard.ForgeForgejo, Repo: "o/a", Number: 1}},
			"o/b": {{Forge: dashboard.ForgeForgejo, Repo: "o/b", Number: 2}},
		},
		issuesByRepo: map[string][]dashboard.Issue{
			"o/b": {{Forge: dashboard.ForgeForgejo, Repo: "o/b", Number: 7}},
		},
	}

	return &flakyForgeClient{fakeForgeClient: base}
}

func newFlakyAggregator(client *flakyForgeClient) *dashboard.Aggregator {
	return dashboard.NewAggregator([]dashboard.Source{dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 2)})
}

func TestAggregator_Refresh_ReachableForgeRepoPullRequestsFail_KeepsItsRowsMarkedStale(t *testing.T) {
	t.Parallel()

	client := twoRepoClient()
	agg := newFlakyAggregator(client)
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().PullRequests, 2)

	client.failPRs = map[string]bool{"o/b": true}
	agg.Refresh(t.Context())

	snap := agg.Get()
	require.True(t, snap.Forges[0].Reachable)
	assert.Len(t, snap.PullRequests, 2, "a repo whose fetch failed keeps the rows it had, not none")
	var stale []string
	for _, r := range snap.Repos {
		if r.StaleSince != nil {
			stale = append(stale, r.FullName)
		}
	}
	assert.Equal(t, []string{"o/b"}, stale, "only the repo that failed is marked stale")
}

func TestAggregator_Refresh_RepoIssuesFail_KeepsIssuesButTakesFreshPullRequests(t *testing.T) {
	t.Parallel()

	client := twoRepoClient()
	agg := newFlakyAggregator(client)
	agg.Refresh(t.Context())

	client.failIssues = map[string]bool{"o/b": true}
	client.prsByRepo["o/b"] = nil // merged meanwhile, and the forge says so
	agg.Refresh(t.Context())

	snap := agg.Get()
	assert.Len(t, snap.Issues, 1, "the issues that could not be fetched stay")
	require.Len(t, snap.PullRequests, 1, "the pull requests that could be fetched are the forge's answer")
	assert.Equal(t, "o/a", snap.PullRequests[0].Repo)
}

func TestAggregator_Refresh_RepoRecovers_ClearsStaleAndTakesFreshRows(t *testing.T) {
	t.Parallel()

	client := twoRepoClient()
	agg := newFlakyAggregator(client)
	agg.Refresh(t.Context())
	client.failPRs = map[string]bool{"o/b": true}
	agg.Refresh(t.Context())

	client.failPRs = nil
	client.prsByRepo["o/b"] = nil // the forge confirms it is gone
	agg.Refresh(t.Context())

	snap := agg.Get()
	assert.Len(t, snap.PullRequests, 1, "a confirmed empty answer drops the rows")
	for _, r := range snap.Repos {
		assert.Nil(t, r.StaleSince, r.FullName)
	}
}

func TestAggregator_Refresh_RepoFailsOnTheFirstRefresh_HasNothingToKeep(t *testing.T) {
	t.Parallel()

	client := twoRepoClient()
	client.failPRs = map[string]bool{"o/b": true}
	agg := newFlakyAggregator(client)
	agg.Refresh(t.Context())

	assert.Len(t, agg.Get().PullRequests, 1)
}
