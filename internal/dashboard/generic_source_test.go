package dashboard_test

import (
	"context"
	"errors"
	"testing"
	"time"

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

type fakeRateLimitedForgeClient struct {
	fakeForgeClient
	rateLimit    dashboard.RateLimit
	rateLimitErr error
}

func (f *fakeRateLimitedForgeClient) RateLimit(_ context.Context) (dashboard.RateLimit, error) {
	return f.rateLimit, f.rateLimitErr
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
	assert.ElementsMatch(t, []dashboard.Repo{
		{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a"},
		{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/b"},
	}, result.Repos)
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

func TestGenericSource_Fetch_ClientWithNoRateLimiter_LeavesRateLimitNil(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClient{}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	result := source.Fetch(t.Context())

	assert.Nil(t, result.Health.RateLimit)
}

func TestGenericSource_Fetch_ClientWithRateLimiter_ReportsIt(t *testing.T) {
	t.Parallel()

	resetsAt := time.Now().Add(time.Hour).UTC()
	client := &fakeRateLimitedForgeClient{
		rateLimit: dashboard.RateLimit{Limit: 5000, Remaining: 4922, ResetsAt: resetsAt},
	}
	source := dashboard.NewGenericSource(dashboard.ForgeGitHub, client, 4)
	result := source.Fetch(t.Context())

	require.NotNil(t, result.Health.RateLimit)
	assert.Equal(t, dashboard.RateLimit{Limit: 5000, Remaining: 4922, ResetsAt: resetsAt}, *result.Health.RateLimit)
}

func TestGenericSource_Fetch_RateLimitCheckFails_StillReportsReachable(t *testing.T) {
	t.Parallel()

	client := &fakeRateLimitedForgeClient{rateLimitErr: errors.New("boom")}
	source := dashboard.NewGenericSource(dashboard.ForgeGitHub, client, 4)
	result := source.Fetch(t.Context())

	assert.True(t, result.Health.Reachable, "a failed rate-limit check shouldn't fail the whole forge")
	assert.Nil(t, result.Health.RateLimit)
}
