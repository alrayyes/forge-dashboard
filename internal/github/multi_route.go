//nolint:wrapcheck // each call hands back the member's own error unchanged: callers classify it with errors.As.
package github

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// The calls below each go to the installation that owns the repo (Owner). They
// are the optional capabilities the aggregator and the API look for by type
// assertion on a source, so Multi has to carry every one a Client does (#4586).

// errCannot is what a call answers when the owning installation does not offer
// it. The message names the installation.
var errCannot = errors.New("cannot do this")

// ErrUnknownRepository is what a write answers for a repo no installation has
// reported. A read may fall back to the first installation; a write must not
// act through an installation that may not own the repo.
var ErrUnknownRepository = errors.New("github: unknown repository")

// routeWrite is routeTo for a call that changes something: it refuses a repo
// no installation has reported.
func routeWrite[T any](m *Multi, owner, name string) (T, error) {
	if _, known := m.lookup(owner, name); !known || len(m.members) == 0 {
		var zero T

		return zero, fmt.Errorf("%w: %s/%s", ErrUnknownRepository, owner, name)
	}

	return routeTo[T](m, owner, name)
}

// routeTo is the owner of owner/name as the capability T, or an error naming
// the installation when it cannot do that.
func routeTo[T any](m *Multi, owner, name string) (T, error) {
	member := m.Owner(owner, name)
	t, ok := member.Source.(T)
	if !ok {
		var zero T

		return zero, fmt.Errorf("github: installation %d %w", member.ID, errCannot)
	}

	return t, nil
}

// CancelRun implements dashboard.RunCanceler.
func (m *Multi) CancelRun(ctx context.Context, owner, name string, runID int64) error {
	t, err := routeWrite[dashboard.RunCanceler](m, owner, name)
	if err != nil {
		return err
	}

	return t.CancelRun(ctx, owner, name, runID)
}

// ListAdvisories implements dashboard.AdvisoryLister.
func (m *Multi) ListAdvisories(ctx context.Context, owner, name string) (dashboard.AdvisoryList, error) {
	t, err := routeTo[dashboard.AdvisoryLister](m, owner, name)
	if err != nil {
		return dashboard.AdvisoryList{}, err
	}

	return t.ListAdvisories(ctx, owner, name)
}

// SignedImageURL implements dashboard.ImageLinkResolver.
func (m *Multi) SignedImageURL(ctx context.Context, owner, name string, item dashboard.ImageItem, link string) (string, error) {
	t, err := routeTo[dashboard.ImageLinkResolver](m, owner, name)
	if err != nil {
		return "", err
	}

	return t.SignedImageURL(ctx, owner, name, item, link)
}

// PullRequestBody implements dashboard.PullRequestBodyEditor.
func (m *Multi) PullRequestBody(ctx context.Context, owner, name string, number int) (string, error) {
	t, err := routeTo[dashboard.PullRequestBodyEditor](m, owner, name)
	if err != nil {
		return "", err
	}

	return t.PullRequestBody(ctx, owner, name, number)
}

// SetPullRequestBody implements dashboard.PullRequestBodyEditor.
func (m *Multi) SetPullRequestBody(ctx context.Context, owner, name string, number int, body string) error {
	t, err := routeWrite[dashboard.PullRequestBodyEditor](m, owner, name)
	if err != nil {
		return err
	}

	return t.SetPullRequestBody(ctx, owner, name, number, body)
}

// FetchMainBranch implements dashboard.MainBranchRefresher.
func (m *Multi) FetchMainBranch(ctx context.Context, owner, name, fullName string) (dashboard.MainBranch, error) {
	t, err := routeTo[dashboard.MainBranchRefresher](m, owner, name)
	if err != nil {
		return dashboard.MainBranch{}, err
	}

	return t.FetchMainBranch(ctx, owner, name, fullName)
}

// GetPullRequestDetails implements dashboard.PullRequestDetailer.
func (m *Multi) GetPullRequestDetails(ctx context.Context, owner, name string, number int) (dashboard.PullRequestDetails, error) {
	t, err := routeTo[dashboard.PullRequestDetailer](m, owner, name)
	if err != nil {
		return dashboard.PullRequestDetails{}, err
	}

	return t.GetPullRequestDetails(ctx, owner, name, number)
}

// RerunFailedChecks implements dashboard.ChecksRerunner.
func (m *Multi) RerunFailedChecks(ctx context.Context, owner, name string, number int) error {
	t, err := routeWrite[dashboard.ChecksRerunner](m, owner, name)
	if err != nil {
		return err
	}

	return t.RerunFailedChecks(ctx, owner, name, number)
}

// CanRerunFailedChecks implements dashboard.ChecksRerunProber.
func (m *Multi) CanRerunFailedChecks(ctx context.Context, owner, name string, number int) error {
	t, err := routeTo[dashboard.ChecksRerunProber](m, owner, name)
	if err != nil {
		return err
	}

	return t.CanRerunFailedChecks(ctx, owner, name, number)
}

// RerunFailedDefaultBranchChecks implements dashboard.DefaultBranchRerunner.
func (m *Multi) RerunFailedDefaultBranchChecks(ctx context.Context, owner, name, branch string) error {
	t, err := routeWrite[dashboard.DefaultBranchRerunner](m, owner, name)
	if err != nil {
		return err
	}

	return t.RerunFailedDefaultBranchChecks(ctx, owner, name, branch)
}

// ReadAdvisories implements dashboard.AdvisoryReader.
func (m *Multi) ReadAdvisories(ctx context.Context, owner, name, repoURL string) (dashboard.Advisories, error) {
	t, err := routeTo[dashboard.AdvisoryReader](m, owner, name)
	if err != nil {
		return dashboard.Advisories{}, err
	}

	return t.ReadAdvisories(ctx, owner, name, repoURL)
}

// HasWebhook implements dashboard.WebhookChecker.
func (m *Multi) HasWebhook(ctx context.Context, owner, name string) (bool, error) {
	t, err := routeTo[dashboard.WebhookChecker](m, owner, name)
	if err != nil {
		return false, err
	}

	return t.HasWebhook(ctx, owner, name)
}

// EnsureWebhook implements dashboard.WebhookManager.
func (m *Multi) EnsureWebhook(ctx context.Context, owner, name, targetURL, secret string) error {
	t, err := routeWrite[dashboard.WebhookManager](m, owner, name)
	if err != nil {
		return err
	}

	return t.EnsureWebhook(ctx, owner, name, targetURL, secret)
}

// UpgradeWebhook implements dashboard.WebhookUpgrader.
func (m *Multi) UpgradeWebhook(ctx context.Context, owner, name, targetURL, secret string) (bool, error) {
	t, err := routeWrite[dashboard.WebhookUpgrader](m, owner, name)
	if err != nil {
		return false, err
	}

	return t.UpgradeWebhook(ctx, owner, name, targetURL, secret)
}

// RewriteWebhookSecret implements dashboard.WebhookSecretRewriter.
func (m *Multi) RewriteWebhookSecret(ctx context.Context, owner, name, targetURL, secret string) (bool, error) {
	t, err := routeWrite[dashboard.WebhookSecretRewriter](m, owner, name)
	if err != nil {
		return false, err
	}

	return t.RewriteWebhookSecret(ctx, owner, name, targetURL, secret)
}

// MergePullRequest implements dashboard.PullRequestMerger.
func (m *Multi) MergePullRequest(ctx context.Context, owner, name string, number int) error {
	t, err := routeWrite[dashboard.PullRequestMerger](m, owner, name)
	if err != nil {
		return err
	}

	return t.MergePullRequest(ctx, owner, name, number)
}

// ReadPullRequestState implements dashboard.PullRequestStateReader.
func (m *Multi) ReadPullRequestState(ctx context.Context, owner, name string, number int) (dashboard.PullRequestState, error) {
	t, err := routeTo[dashboard.PullRequestStateReader](m, owner, name)
	if err != nil {
		return dashboard.PullRequestState{}, err
	}

	return t.ReadPullRequestState(ctx, owner, name, number)
}

// ClosePullRequest implements dashboard.PullRequestCloser.
func (m *Multi) ClosePullRequest(ctx context.Context, owner, name string, number int) error {
	t, err := routeWrite[dashboard.PullRequestCloser](m, owner, name)
	if err != nil {
		return err
	}

	return t.ClosePullRequest(ctx, owner, name, number)
}

// ReopenPullRequest implements dashboard.PullRequestReopener.
func (m *Multi) ReopenPullRequest(ctx context.Context, owner, name string, number int) error {
	t, err := routeWrite[dashboard.PullRequestReopener](m, owner, name)
	if err != nil {
		return err
	}

	return t.ReopenPullRequest(ctx, owner, name, number)
}

// EnableAutoMerge implements dashboard.PullRequestAutoMerger.
func (m *Multi) EnableAutoMerge(ctx context.Context, owner, name string, number int) error {
	t, err := routeWrite[dashboard.PullRequestAutoMerger](m, owner, name)
	if err != nil {
		return err
	}

	return t.EnableAutoMerge(ctx, owner, name, number)
}

// DisableAutoMerge implements dashboard.PullRequestAutoMergeDisabler.
func (m *Multi) DisableAutoMerge(ctx context.Context, owner, name string, number int) error {
	t, err := routeWrite[dashboard.PullRequestAutoMergeDisabler](m, owner, name)
	if err != nil {
		return err
	}

	return t.DisableAutoMerge(ctx, owner, name, number)
}

// UpdateBranch implements dashboard.BranchUpdater.
func (m *Multi) UpdateBranch(ctx context.Context, owner, name string, number int) (bool, error) {
	t, err := routeWrite[dashboard.BranchUpdater](m, owner, name)
	if err != nil {
		return false, err
	}

	return t.UpdateBranch(ctx, owner, name, number)
}

// CommentPullRequest implements dashboard.PullRequestCommenter.
func (m *Multi) CommentPullRequest(ctx context.Context, owner, name string, number int, body string) error {
	t, err := routeWrite[dashboard.PullRequestCommenter](m, owner, name)
	if err != nil {
		return err
	}

	return t.CommentPullRequest(ctx, owner, name, number, body)
}

// AddLabel implements dashboard.PullRequestLabeler.
func (m *Multi) AddLabel(ctx context.Context, owner, name string, number int, label string) error {
	t, err := routeWrite[dashboard.PullRequestLabeler](m, owner, name)
	if err != nil {
		return err
	}

	return t.AddLabel(ctx, owner, name, number, label)
}

// FetchRepo implements dashboard.RepoRefresher.
func (m *Multi) FetchRepo(ctx context.Context, owner, name, fullName string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	t, err := routeTo[dashboard.RepoRefresher](m, owner, name)
	if err != nil {
		return nil, nil, err
	}

	return t.FetchRepo(ctx, owner, name, fullName)
}

// ListChecks implements dashboard.PullRequestChecker.
func (m *Multi) ListChecks(ctx context.Context, owner, name string, number int) ([]dashboard.Check, error) {
	t, err := routeTo[dashboard.PullRequestChecker](m, owner, name)
	if err != nil {
		return nil, err
	}

	return t.ListChecks(ctx, owner, name, number)
}

// ListDefaultBranchChecks implements dashboard.DefaultBranchChecker.
func (m *Multi) ListDefaultBranchChecks(ctx context.Context, owner, name string) ([]dashboard.Check, error) {
	t, err := routeTo[dashboard.DefaultBranchChecker](m, owner, name)
	if err != nil {
		return nil, err
	}

	return t.ListDefaultBranchChecks(ctx, owner, name)
}

// DependabotAck implements dashboard.DependabotAckReader.
func (m *Multi) DependabotAck(ctx context.Context, owner, name string, number int, command string, since time.Time) (dashboard.CommandAck, error) {
	t, err := routeTo[dashboard.DependabotAckReader](m, owner, name)
	if err != nil {
		return dashboard.CommandAck{}, err
	}

	return t.DependabotAck(ctx, owner, name, number, command, since)
}

// JobLog implements dashboard.JobLogReader.
func (m *Multi) JobLog(ctx context.Context, owner, name string, id int64) (dashboard.JobLog, error) {
	t, err := routeTo[dashboard.JobLogReader](m, owner, name)
	if err != nil {
		return dashboard.JobLog{}, err
	}

	return t.JobLog(ctx, owner, name, id)
}

// CloseIssue implements dashboard.IssueCloser.
func (m *Multi) CloseIssue(ctx context.Context, owner, name string, number int) error {
	t, err := routeWrite[dashboard.IssueCloser](m, owner, name)
	if err != nil {
		return err
	}

	return t.CloseIssue(ctx, owner, name, number)
}

// ReopenIssue implements dashboard.IssueReopener.
func (m *Multi) ReopenIssue(ctx context.Context, owner, name string, number int) error {
	t, err := routeWrite[dashboard.IssueReopener](m, owner, name)
	if err != nil {
		return err
	}

	return t.ReopenIssue(ctx, owner, name, number)
}

// CommentIssue implements dashboard.IssueCommenter.
func (m *Multi) CommentIssue(ctx context.Context, owner, name string, number int, body string) error {
	t, err := routeWrite[dashboard.IssueCommenter](m, owner, name)
	if err != nil {
		return err
	}

	return t.CommentIssue(ctx, owner, name, number, body)
}

// GetIssueDetails implements dashboard.IssueDetailer.
func (m *Multi) GetIssueDetails(ctx context.Context, owner, name string, number int) (dashboard.IssueDetails, error) {
	t, err := routeTo[dashboard.IssueDetailer](m, owner, name)
	if err != nil {
		return dashboard.IssueDetails{}, err
	}

	return t.GetIssueDetails(ctx, owner, name, number)
}

// GetReleaseDetails implements dashboard.ReleaseDetailer.
func (m *Multi) GetReleaseDetails(ctx context.Context, owner, name, tag string) (dashboard.ReleaseDetails, error) {
	t, err := routeTo[dashboard.ReleaseDetailer](m, owner, name)
	if err != nil {
		return dashboard.ReleaseDetails{}, err
	}

	return t.GetReleaseDetails(ctx, owner, name, tag)
}

// DeletePullRequestBranch implements dashboard.PullRequestBranchDeleter.
func (m *Multi) DeletePullRequestBranch(ctx context.Context, owner, name string, number int) dashboard.BranchDeletion {
	t, err := routeWrite[dashboard.PullRequestBranchDeleter](m, owner, name)
	if err != nil {
		return dashboard.BranchDeletion{Outcome: dashboard.BranchDeleteFailed}
	}

	return t.DeletePullRequestBranch(ctx, owner, name, number)
}
