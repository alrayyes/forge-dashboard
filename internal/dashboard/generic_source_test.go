package dashboard_test

import (
	"context"
	"errors"
	"fmt"
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

// TestGenericSource_Fetch_ListReposFails_ErrorIsHumanized proves the
// underlying client error's own text never reaches ForgeHealth.Error
// (#360) — only humanizeForgeError's mapped sentence does, regardless of
// what the failing ForgeClient's own error actually says.
func TestGenericSource_Fetch_ListReposFails_ErrorIsHumanized(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClient{
		listReposErr: errors.New("dial tcp 10.0.0.1:3000: connect: connection refused"),
	}

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	result := source.Fetch(t.Context())

	assert.False(t, result.Health.Reachable)
	assert.NotContains(t, result.Health.Error, "dial tcp")
	assert.NotContains(t, result.Health.Error, "10.0.0.1")
	assert.Equal(t, dashboard.HumanizeForgeError(dashboard.ForgeErrorUnknown), result.Health.Error)
}

func TestGenericSource_Fetch_ClientWithNoRateLimiter_LeavesRateLimitNil(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClient{}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	result := source.Fetch(t.Context())

	assert.Nil(t, result.Health.RateLimitREST)
}

func TestGenericSource_Fetch_ClientWithRateLimiter_ReportsIt(t *testing.T) {
	t.Parallel()

	resetsAt := time.Now().Add(time.Hour).UTC()
	client := &fakeRateLimitedForgeClient{
		rateLimit: dashboard.RateLimit{Limit: 5000, Remaining: 4922, ResetsAt: resetsAt},
	}
	source := dashboard.NewGenericSource(dashboard.ForgeGitHub, client, 4)
	result := source.Fetch(t.Context())

	require.NotNil(t, result.Health.RateLimitREST)
	assert.Equal(t, dashboard.RateLimit{Limit: 5000, Remaining: 4922, ResetsAt: resetsAt}, *result.Health.RateLimitREST)
}

func TestGenericSource_Fetch_RateLimitCheckFails_StillReportsReachable(t *testing.T) {
	t.Parallel()

	client := &fakeRateLimitedForgeClient{rateLimitErr: errors.New("boom")}
	source := dashboard.NewGenericSource(dashboard.ForgeGitHub, client, 4)
	result := source.Fetch(t.Context())

	assert.True(t, result.Health.Reachable, "a failed rate-limit check shouldn't fail the whole forge")
	assert.Nil(t, result.Health.RateLimitREST)
}

type fakeWebhookCheckerClient struct {
	fakeForgeClient
	hasWebhookByFullName map[string]bool
	errByFullName        map[string]error
}

func (f *fakeWebhookCheckerClient) HasWebhook(_ context.Context, owner, name string) (bool, error) {
	fullName := owner + "/" + name
	if err := f.errByFullName[fullName]; err != nil {
		return false, err
	}

	return f.hasWebhookByFullName[fullName], nil
}

func TestGenericSource_Fetch_ClientWithNoWebhookChecker_LeavesHasWebhookFalse(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClient{
		repos: []dashboard.RepoRef{{FullName: "alrayyes/a", Owner: "alrayyes", Name: "a"}},
	}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	result := source.Fetch(t.Context())

	require.Len(t, result.Repos, 1)
	assert.False(t, result.Repos[0].HasWebhook)
}

func TestGenericSource_Fetch_ClientWithWebhookChecker_ReportsPerRepo(t *testing.T) {
	t.Parallel()

	client := &fakeWebhookCheckerClient{
		repos: []dashboard.RepoRef{
			{FullName: "alrayyes/a", Owner: "alrayyes", Name: "a"},
			{FullName: "alrayyes/b", Owner: "alrayyes", Name: "b"},
		},
		hasWebhookByFullName: map[string]bool{"alrayyes/a": true},
	}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	result := source.Fetch(t.Context())

	byName := map[string]bool{}
	for _, r := range result.Repos {
		byName[r.FullName] = r.HasWebhook
	}
	assert.True(t, byName["alrayyes/a"])
	assert.False(t, byName["alrayyes/b"])
}

func TestGenericSource_Fetch_WebhookCheckFails_StillReportsReachableWithHasWebhookFalse(t *testing.T) {
	t.Parallel()

	client := &fakeWebhookCheckerClient{
		repos:         []dashboard.RepoRef{{FullName: "alrayyes/a", Owner: "alrayyes", Name: "a"}},
		errByFullName: map[string]error{"alrayyes/a": errors.New("boom")},
	}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	result := source.Fetch(t.Context())

	assert.True(t, result.Health.Reachable)
	require.Len(t, result.Repos, 1)
	assert.False(t, result.Repos[0].HasWebhook)
}

type fakeWebhookManagerClient struct {
	fakeForgeClient
	ensureCalls []string
	ensureErr   error
}

func (f *fakeWebhookManagerClient) EnsureWebhook(_ context.Context, owner, name, targetURL, secret string) error {
	f.ensureCalls = append(f.ensureCalls, owner+"/"+name+" "+targetURL+" "+secret)

	return f.ensureErr
}

func TestGenericSource_EnsureWebhook_DelegatesToClient(t *testing.T) {
	t.Parallel()

	client := &fakeWebhookManagerClient{}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	err := source.EnsureWebhook(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/forgejo/tok", "sekret")

	require.NoError(t, err)
	require.Len(t, client.ensureCalls, 1)
	assert.Equal(t, "alrayyes/a https://dashboard.example/api/webhooks/forgejo/tok sekret", client.ensureCalls[0])
}

func TestGenericSource_EnsureWebhook_PropagatesClientError(t *testing.T) {
	t.Parallel()

	client := &fakeWebhookManagerClient{ensureErr: errors.New("boom")}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	err := source.EnsureWebhook(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/forgejo/tok", "sekret")

	require.Error(t, err)
}

func TestGenericSource_EnsureWebhook_ClientWithoutSupport_ReturnsError(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClient{}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	err := source.EnsureWebhook(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/forgejo/tok", "sekret")

	require.Error(t, err)
}

// #455: Forgejo's own client (internal/forgejo.Client) implements
// dashboard.PullRequestChecker, but the Source BuildSources actually
// registers for Forgejo is a *GenericSource wrapping it — confirmed live,
// the "View pipeline" button on a real Forgejo pull request answered
// "forgejo doesn't support listing pull request checks" even though the
// underlying client genuinely can. The bug was never in the client; it
// was GenericSource never forwarding the capability, the same way
// EnsureWebhook/MergePullRequest/UpdateBranch already do.
type fakeCheckerClient struct {
	fakeForgeClient
	checks    []dashboard.Check
	checksErr error
	calls     []string
}

func (f *fakeCheckerClient) ListChecks(_ context.Context, owner, name string, number int) ([]dashboard.Check, error) {
	f.calls = append(f.calls, owner+"/"+name+fmt.Sprintf("#%d", number))

	return f.checks, f.checksErr
}

func TestGenericSource_ListChecks_DelegatesToClient(t *testing.T) {
	t.Parallel()

	client := &fakeCheckerClient{checks: []dashboard.Check{{Name: "build", State: dashboard.CheckSuccess, URL: "https://example.com/1"}}}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	checks, err := source.ListChecks(t.Context(), "alrayyes", "a", 42)

	require.NoError(t, err)
	require.Len(t, client.calls, 1)
	assert.Equal(t, "alrayyes/a#42", client.calls[0])
	assert.Equal(t, client.checks, checks)
}

func TestGenericSource_ListChecks_PropagatesClientError(t *testing.T) {
	t.Parallel()

	client := &fakeCheckerClient{checksErr: errors.New("boom")}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	_, err := source.ListChecks(t.Context(), "alrayyes", "a", 42)

	require.Error(t, err)
}

func TestGenericSource_ListChecks_ClientWithoutSupport_ReturnsError(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClient{}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	_, err := source.ListChecks(t.Context(), "alrayyes", "a", 42)

	require.Error(t, err)
}
