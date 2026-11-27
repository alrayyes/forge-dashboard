package github_test

import (
	"context"
	"errors"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Everything the aggregator and the API look for on the GitHub source, the
// composite has to offer too (#4586).
var (
	_ dashboard.BudgetReporter               = (*github.Multi)(nil)
	_ dashboard.Source                       = (*github.Multi)(nil)
	_ dashboard.PullRequestStateReader       = (*github.Multi)(nil)
	_ dashboard.AdvisoryReader               = (*github.Multi)(nil)
	_ dashboard.AdvisoryLister               = (*github.Multi)(nil)
	_ dashboard.ImageLinkResolver            = (*github.Multi)(nil)
	_ dashboard.IssueDetailer                = (*github.Multi)(nil)
	_ dashboard.JobLogReader                 = (*github.Multi)(nil)
	_ dashboard.ProviderStatusSource         = (*github.Multi)(nil)
	_ dashboard.ReleaseDetailer              = (*github.Multi)(nil)
	_ dashboard.PullRequestDetailer          = (*github.Multi)(nil)
	_ dashboard.PullRequestBodyEditor        = (*github.Multi)(nil)
	_ dashboard.CredentialLabeler            = (*github.Multi)(nil)
	_ dashboard.RepoRefresher                = (*github.Multi)(nil)
	_ dashboard.MainBranchRefresher          = (*github.Multi)(nil)
	_ dashboard.WebhookChecker               = (*github.Multi)(nil)
	_ dashboard.WebhookManager               = (*github.Multi)(nil)
	_ dashboard.WebhookUpgrader              = (*github.Multi)(nil)
	_ dashboard.WebhookSecretRewriter        = (*github.Multi)(nil)
	_ dashboard.PullRequestMerger            = (*github.Multi)(nil)
	_ dashboard.PullRequestBranchDeleter     = (*github.Multi)(nil)
	_ dashboard.PullRequestAutoMerger        = (*github.Multi)(nil)
	_ dashboard.PullRequestAutoMergeDisabler = (*github.Multi)(nil)
	_ dashboard.PullRequestCloser            = (*github.Multi)(nil)
	_ dashboard.PullRequestReopener          = (*github.Multi)(nil)
	_ dashboard.ChecksRerunner               = (*github.Multi)(nil)
	_ dashboard.ChecksRerunProber            = (*github.Multi)(nil)
	_ dashboard.DefaultBranchRerunner        = (*github.Multi)(nil)
	_ dashboard.RunCanceler                  = (*github.Multi)(nil)
	_ dashboard.BranchUpdater                = (*github.Multi)(nil)
	_ dashboard.DependabotCommandBlocker     = (*github.Multi)(nil)
	_ dashboard.PullRequestCommenter         = (*github.Multi)(nil)
	_ dashboard.DependabotAckReader          = (*github.Multi)(nil)
	_ dashboard.PullRequestLabeler           = (*github.Multi)(nil)
	_ dashboard.PullRequestChecker           = (*github.Multi)(nil)
	_ dashboard.DefaultBranchChecker         = (*github.Multi)(nil)
	_ dashboard.PendingCheckRefresher        = (*github.Multi)(nil)
	_ dashboard.WebhookEventsReporter        = (*github.Multi)(nil)
	_ dashboard.IssueCloser                  = (*github.Multi)(nil)
	_ dashboard.IssueReopener                = (*github.Multi)(nil)
	_ dashboard.IssueCommenter               = (*github.Multi)(nil)
)

// actingInstallation answers the calls the routing tests make, and says which
// installation answered.
type actingInstallation struct {
	fakeInstallation
	id      string
	blocked string
	status  *dashboard.ProviderStatus
}

func (a actingInstallation) MergePullRequest(context.Context, string, string, int) error {
	return assertedError(a.id)
}

func (a actingInstallation) CommentPullRequest(_ context.Context, _, _ string, _ int, body string) error {
	return assertedError(a.id + ":" + body)
}

func (a actingInstallation) JobLog(context.Context, string, string, int64) (dashboard.JobLog, error) {
	return dashboard.JobLog{Text: a.id}, nil
}

func (a actingInstallation) DeletePullRequestBranch(context.Context, string, string, int) dashboard.BranchDeletion {
	return dashboard.BranchDeletion{Outcome: dashboard.BranchDeletionOutcome(a.id)}
}

func (a actingInstallation) FetchRepo(_ context.Context, _, _, full string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	return []dashboard.PullRequest{{Repo: full, Title: a.id}}, nil, nil
}

func (a actingInstallation) WebhookEvents(string) ([]string, bool)   { return []string{a.id}, true }
func (a actingInstallation) CredentialLabel() string                 { return "app:" + a.id }
func (a actingInstallation) DependabotCommandsBlockedReason() string { return a.blocked }

func (a actingInstallation) ProviderStatus(context.Context) *dashboard.ProviderStatus {
	return a.status
}

func (a actingInstallation) RefreshPending(_ context.Context, refs []dashboard.PullRequestRef) (dashboard.PendingResult, error) {
	var res dashboard.PendingResult
	for _, r := range refs {
		res.Pulls = append(res.Pulls, dashboard.PullRequest{Repo: r.FullName, Title: a.id})
	}

	return res, nil
}

type assertedError string

func (e assertedError) Error() string { return string(e) }

func twoActing(t *testing.T) *github.Multi {
	t.Helper()
	a := actingInstallation{fakeInstallation: fakeInstallation{answered("alice/a", 10)}, id: "one"}
	b := actingInstallation{fakeInstallation: fakeInstallation{answered("acme/b", 10)}, id: "two"}
	m := github.NewMulti([]github.Member{{ID: 1, Source: a}, {ID: 2, Source: b}})
	m.Fetch(t.Context())

	return m
}

func TestMulti_WritesGoToTheInstallationThatOwnsTheRepo(t *testing.T) {
	m := twoActing(t)

	require.EqualError(t, m.MergePullRequest(t.Context(), "acme", "b", 1), "two")
	require.EqualError(t, m.MergePullRequest(t.Context(), "alice", "a", 1), "one")
	require.EqualError(t, m.CommentPullRequest(t.Context(), "acme", "b", 1, "hi"), "two:hi")
	assert.Equal(t, dashboard.BranchDeletionOutcome("two"), m.DeletePullRequestBranch(t.Context(), "acme", "b", 1).Outcome)
}

func TestMulti_ReadsGoToTheInstallationThatOwnsTheRepo(t *testing.T) {
	m := twoActing(t)

	log, err := m.JobLog(t.Context(), "acme", "b", 9)
	require.NoError(t, err)
	assert.Equal(t, "two", log.Text)

	prs, _, err := m.FetchRepo(t.Context(), "alice", "a", "alice/a")
	require.NoError(t, err)
	assert.Equal(t, "one", prs[0].Title)

	events, ok := m.WebhookEvents("acme/b")
	assert.True(t, ok)
	assert.Equal(t, []string{"two"}, events)
}

func TestMulti_AnInstallationWithoutTheCapabilityRefuses(t *testing.T) {
	m := github.NewMulti([]github.Member{{ID: 7, Source: fakeInstallation{answered("a/b", 1)}}})
	m.Fetch(t.Context())

	err := m.MergePullRequest(t.Context(), "a", "b", 1)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "installation 7")
}

func TestMulti_RefreshPendingAsksEachInstallationAboutItsOwnRepos(t *testing.T) {
	m := twoActing(t)
	refs := []dashboard.PullRequestRef{
		{Owner: "acme", Name: "b", FullName: "acme/b", Number: 1},
		{Owner: "alice", Name: "a", FullName: "alice/a", Number: 2},
	}

	res, err := m.RefreshPending(t.Context(), refs)

	require.NoError(t, err)
	titles := map[string]string{}
	for _, pr := range res.Pulls {
		titles[pr.Repo] = pr.Title
	}
	assert.Equal(t, map[string]string{"acme/b": "two", "alice/a": "one"}, titles)
}

func TestMulti_RepoLessCallsUseTheFirstInstallation(t *testing.T) {
	status := &dashboard.ProviderStatus{Indicator: "minor"}
	m := github.NewMulti([]github.Member{
		{ID: 1, Source: actingInstallation{id: "one", blocked: "no dependabot", status: status}},
		{ID: 2, Source: actingInstallation{id: "two"}},
	})

	assert.Equal(t, "app:one", m.CredentialLabel())
	assert.Equal(t, "no dependabot", m.DependabotCommandsBlockedReason())
	assert.Equal(t, status, m.ProviderStatus(t.Context()))
}

func TestMulti_RefreshPendingWithNoMembersFailsEveryRef(t *testing.T) {
	m := github.NewMulti(nil)
	refs := []dashboard.PullRequestRef{{Owner: "acme", Name: "b", Number: 1}}

	res, err := m.RefreshPending(t.Context(), refs)

	require.NoError(t, err)
	assert.Equal(t, refs, res.Failed)
}

func TestMulti_WritesToARepoNoInstallationHasReportedAreRefused(t *testing.T) {
	m := twoActing(t)

	err := m.MergePullRequest(t.Context(), "stranger", "repo", 1)
	require.ErrorIs(t, err, github.ErrUnknownRepository)
	require.ErrorIs(t, m.CommentPullRequest(t.Context(), "stranger", "repo", 1, "hi"), github.ErrUnknownRepository)
	require.ErrorIs(t, m.CloseIssue(t.Context(), "stranger", "repo", 1), github.ErrUnknownRepository)
	assert.Equal(t, dashboard.BranchDeleteFailed, m.DeletePullRequestBranch(t.Context(), "stranger", "repo", 1).Outcome)
}

func TestMulti_ReadsOfAnUnknownRepoStillTryTheFirstInstallation(t *testing.T) {
	m := twoActing(t)

	log, err := m.JobLog(t.Context(), "stranger", "repo", 9)

	require.NoError(t, err)
	assert.Equal(t, "one", log.Text)
}

func TestMulti_RefreshPendingKeepsGoingAndNamesEachFailingInstallation(t *testing.T) {
	a := refreshing{fakeInstallation: fakeInstallation{answered("alice/a", 1)}, err: errors.New("boom a")}
	b := refreshing{fakeInstallation: fakeInstallation{answered("acme/b", 1)}, pull: "acme/b"}
	c := refreshing{fakeInstallation: fakeInstallation{answered("zed/c", 1)}, err: errors.New("boom c")}
	m := github.NewMulti([]github.Member{{ID: 11, Source: a}, {ID: 22, Source: b}, {ID: 33, Source: c}})
	m.Fetch(t.Context())

	res, err := m.RefreshPending(t.Context(), []dashboard.PullRequestRef{
		{Owner: "alice", Name: "a", Number: 1}, {Owner: "acme", Name: "b", Number: 2}, {Owner: "zed", Name: "c", Number: 3},
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "installation 11")
	assert.Contains(t, err.Error(), "boom a")
	assert.Contains(t, err.Error(), "installation 33")
	assert.Contains(t, err.Error(), "boom c")
	assert.NotContains(t, err.Error(), "installation 22")
	require.Len(t, res.Pulls, 1, "the healthy installation still answered")
}

// refreshing answers RefreshPending with its own pull request, or its error.
type refreshing struct {
	fakeInstallation
	pull string
	err  error
}

func (r refreshing) RefreshPending(context.Context, []dashboard.PullRequestRef) (dashboard.PendingResult, error) {
	if r.err != nil {
		return dashboard.PendingResult{}, r.err
	}

	return dashboard.PendingResult{Pulls: []dashboard.PullRequest{{Repo: r.pull}}}, nil
}
