package dashboard_test

import (
	"context"
	"errors"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeForgeClient struct {
	repos               []dashboard.RepoRef
	listReposErr        error
	prsByRepo           map[string][]dashboard.PullRequest
	issuesByRepo        map[string][]dashboard.Issue
	failReposByFullName map[string]bool
}

func (f *fakeForgeClient) ListRepos(_ context.Context) ([]dashboard.RepoRef, error) {
	return f.repos, f.listReposErr
}

func (f *fakeForgeClient) ListOpenPullRequests(_ context.Context, _, _, repo string) ([]dashboard.PullRequest, error) {
	if f.failReposByFullName[repo] {
		return nil, errors.New("boom")
	}
	return f.prsByRepo[repo], nil
}

func (f *fakeForgeClient) ListOpenIssues(_ context.Context, _, _, repo string) ([]dashboard.Issue, error) {
	return f.issuesByRepo[repo], nil
}

func TestGenericSource_Fetch_AggregatesAcrossRepos(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClient{
		repos: []dashboard.RepoRef{
			{FullName: "alrayyes/a", Owner: "alrayyes", Name: "a"},
			{FullName: "alrayyes/b", Owner: "alrayyes", Name: "b"},
		},
		prsByRepo: map[string][]dashboard.PullRequest{
			"alrayyes/a": {{Number: 1}},
			"alrayyes/b": {{Number: 2}, {Number: 3}},
		},
		issuesByRepo: map[string][]dashboard.Issue{
			"alrayyes/a": {{Number: 10}},
		},
	}

	source := dashboard.NewGenericSource(dashboard.ForgeGitHub, client, 4)
	result := source.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	assert.Equal(t, 2, result.Health.RepoCount)
	assert.Len(t, result.PullRequests, 3, "pull requests across both repos")
	assert.Len(t, result.Issues, 1)
}

func TestGenericSource_Fetch_OneRepoFails_OthersStillReported(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClient{
		repos: []dashboard.RepoRef{
			{FullName: "alrayyes/a", Owner: "alrayyes", Name: "a"},
			{FullName: "alrayyes/broken", Owner: "alrayyes", Name: "broken"},
		},
		prsByRepo: map[string][]dashboard.PullRequest{
			"alrayyes/a": {{Number: 1}},
		},
		failReposByFullName: map[string]bool{"alrayyes/broken": true},
	}

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	result := source.Fetch(t.Context())

	require.True(t, result.Health.Reachable, "the forge should still report reachable despite one repo failing")
	assert.Len(t, result.PullRequests, 1, "repo a's pull request should survive repo broken failing")
}

func TestGenericSource_Fetch_ListReposFails_ReportsUnreachable(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClient{listReposErr: errors.New("dial tcp: timeout")}

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	result := source.Fetch(t.Context())

	assert.False(t, result.Health.Reachable)
	assert.NotEmpty(t, result.Health.Error)
}
