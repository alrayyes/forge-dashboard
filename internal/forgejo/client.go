// Package forgejo is a client for the pieces of the Forgejo API
// (Gitea-compatible) forge-dashboard needs — the same shape as
// internal/github, against a different API under a self-hosted host.
// Driven by code.gitea.io/sdk/gitea, the official Gitea Go client and the
// one Forgejo's own API compatibility targets, rather than hand-rolled
// requests.
package forgejo

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// pageLimit is the page size used for every paginated list call. Forgejo's
// default per-page maximum is 50 unless an instance admin raises it, so
// this stays conservative rather than assuming a larger limit was set.
const pageLimit = 50

// Client talks to a Forgejo instance's API, either as an authenticated
// user (a token) or anonymously against one user's public repositories on
// that instance (a username, no token at all).
type Client struct {
	sdk         *gitea.Client
	token       string
	username    string
	webhookPath string
}

// NewClient returns a Client against instanceURL (e.g.
// "https://git.higherlearning.eu"). With token set, it authenticates as
// that user and ListRepos returns every repo the token can push to,
// private included. With token empty and username set, every request
// goes out unauthenticated and ListRepos returns only username's public
// repos on that instance.
func NewClient(instanceURL, token, username string) *Client {
	opts := []gitea.ClientOption{
		gitea.SetHTTPClient(&http.Client{Timeout: 30 * time.Second}),
		// Skips the server-version probe NewClient otherwise makes on
		// every construction: this client only ever calls endpoints
		// that have been stable since Gitea 1.11, so there's nothing to
		// gate on a version check for.
		gitea.SetGiteaVersion(""),
	}
	if token != "" {
		opts = append(opts, gitea.SetToken(token))
	}

	sdk, err := gitea.NewClient(instanceURL, opts...)
	if err != nil {
		// SetHTTPClient, SetToken and SetGiteaVersion("") never fail,
		// and SetGiteaVersion("") disables the one check (a server-version
		// probe) that otherwise could — this can't actually happen.
		panic(fmt.Sprintf("forgejo: unexpected client construction error: %v", err))
	}

	return &Client{sdk: sdk, token: token, username: username}
}

func (c *Client) setContext(ctx context.Context) {
	c.sdk.SetContext(ctx)
}

// SetWebhookPath tells Client the path (not the full URL — see
// dashboard.WebhookTargetsPath) this account's own Forgejo webhook
// endpoint lives at, e.g. "/api/webhooks/forgejo/<token>". Left unset,
// HasWebhook always reports false without calling the forge at all —
// the same "optional, degrades quietly" shape RateLimit's nil pointer
// already uses elsewhere in this codebase.
func (c *Client) SetWebhookPath(path string) {
	c.webhookPath = path
}

// HasWebhook implements dashboard.WebhookChecker: does repo owner/name
// already have a webhook whose target URL is this account's own
// webhook endpoint. Forgejo's hooks API has no separate read-only
// scope — listing needs the same write:repository scope creating one
// does (see #234's research, cited on settings.html's token
// instructions).
func (c *Client) HasWebhook(ctx context.Context, owner, name string) (bool, error) {
	if c.webhookPath == "" {
		return false, nil
	}
	hook, err := c.findOwnHook(ctx, owner, name, c.webhookPath)
	if err != nil {
		return false, err
	}
	return hook != nil, nil
}

// findOwnHook returns the hook among owner/name's own hooks whose target
// URL's path matches wantPath (dashboard.WebhookTargetsPath), or nil if
// none does — shared by HasWebhook (which always matches against
// c.webhookPath) and EnsureWebhook (which matches against whatever
// path its own targetURL argument carries, independent of whether
// SetWebhookPath was ever called on this Client at all).
func (c *Client) findOwnHook(ctx context.Context, owner, name, wantPath string) (*gitea.Hook, error) {
	c.setContext(ctx)
	path := fmt.Sprintf("/repos/%s/%s/hooks", owner, name)
	opt := gitea.ListHooksOptions{ListOptions: gitea.ListOptions{PageSize: pageLimit}}

	for {
		slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
		hooks, resp, err := c.sdk.ListRepoHooks(owner, name, opt)
		if err != nil {
			return nil, forgejoError(http.MethodGet, path, resp, err)
		}
		for _, h := range hooks {
			if dashboard.WebhookTargetsPath(h.Config["url"], wantPath) {
				return h, nil
			}
		}
		if resp.NextPage == 0 {
			break
		}
		opt.Page = resp.NextPage
	}
	return nil, nil
}

// forgejoWebhookEvents mirrors what docs/webhooks.md's manual Forgejo
// steps have a user tick by hand — Pull Request, Issue, Push, and
// Status — so a webhook created here covers the same ground.
var forgejoWebhookEvents = []string{"pull_request", "issues", "push", "status"}

// EnsureWebhook implements dashboard.WebhookManager: create a webhook
// targeting targetURL if owner/name has none yet, or bring an existing
// one (found by matching targetURL's own path, not c.webhookPath — this
// method is self-contained even if SetWebhookPath was never called)
// back to active with the right config rather than creating a second,
// duplicate hook.
func (c *Client) EnsureWebhook(ctx context.Context, owner, name, targetURL, secret string) error {
	u, err := url.Parse(targetURL)
	if err != nil {
		return fmt.Errorf("forgejo: invalid webhook target URL: %w", err)
	}

	existing, err := c.findOwnHook(ctx, owner, name, u.Path)
	if err != nil {
		return err
	}

	config := map[string]string{
		"url":          targetURL,
		"content_type": "json",
		"secret":       secret,
	}

	c.setContext(ctx)
	if existing != nil {
		path := fmt.Sprintf("/repos/%s/%s/hooks/%d", owner, name, existing.ID)
		slog.Debug("forgejo request", "method", http.MethodPatch, "url", path)
		active := true
		resp, err := c.sdk.EditRepoHook(owner, name, existing.ID, gitea.EditHookOption{
			Config: config,
			Events: forgejoWebhookEvents,
			Active: &active,
		})
		if err != nil {
			return forgejoError(http.MethodPatch, path, resp, err)
		}
		return nil
	}

	path := fmt.Sprintf("/repos/%s/%s/hooks", owner, name)
	slog.Debug("forgejo request", "method", http.MethodPost, "url", path)
	// HookTypeGitea, not a "forgejo" one: this SDK version has no such
	// constant, and Forgejo's API accepts the Gitea-compatible type
	// name the same way it accepts X-Gitea-Signature as a fallback for
	// deliveries (see handleForgejoWebhook's own doc comment).
	_, resp, err := c.sdk.CreateRepoHook(owner, name, gitea.CreateHookOption{
		Type:   gitea.HookTypeGitea,
		Config: config,
		Events: forgejoWebhookEvents,
		Active: true,
	})
	if err != nil {
		return forgejoError(http.MethodPost, path, resp, err)
	}
	return nil
}

// forgejoError turns a failed gitea SDK call into the reason a person
// reading the dashboard's forge-health error actually needs: the
// instance's own error message (already extracted from the response body
// by the SDK), plus a Retry-After wait (RFC 9110 §10.2.3) where a
// fronting proxy or the instance itself sent one — Forgejo has no
// built-in rate limiting of its own, but this still covers an instance
// sitting behind one that does. The SDK's *Response is populated even on
// a failed request, which is what makes the header still readable here;
// a nil resp means the request never got a response at all.
func forgejoError(method, path string, resp *gitea.Response, err error) error {
	msg := err.Error()
	kind := dashboard.ForgeErrorUnreachable
	if resp != nil {
		if retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {
			msg += fmt.Sprintf(" (retry after %ss)", retryAfter)
		}
		kind = forgeErrorKind(resp.StatusCode)
	}
	wrapped := fmt.Errorf("forgejo: %s %s: %s", method, path, msg)
	return &dashboard.ClientError{Kind: kind, Err: wrapped}
}

// forgeErrorKind classifies an HTTP status code from a response that was
// actually received — callers pass ForgeErrorUnreachable directly when
// there was no response at all, since there's no status code to read.
func forgeErrorKind(statusCode int) dashboard.ForgeErrorKind {
	switch statusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return dashboard.ForgeErrorUnauthorized
	case http.StatusNotFound:
		return dashboard.ForgeErrorNotFound
	case http.StatusTooManyRequests:
		return dashboard.ForgeErrorRateLimited
	// MethodNotAllowed is what Gitea/Forgejo's own merge endpoint returns
	// for a PR that isn't currently mergeable; Conflict covers the same
	// case on any endpoint that uses the more conventional status.
	case http.StatusMethodNotAllowed, http.StatusConflict:
		return dashboard.ForgeErrorConflict
	default:
		return dashboard.ForgeErrorUnknown
	}
}

// MergePullRequest implements dashboard.PullRequestMerger: merges
// owner/name#number using the repo's own configured default merge style.
// Unlike GitHub, Forgejo's merge API has no "use the repo default"
// sentinel — MergePullRequestOption.Style is a required field on the
// wire — so this looks the repo's DefaultMergeStyle up first rather than
// hardcoding one style for every repo regardless of its own settings.
func (c *Client) MergePullRequest(ctx context.Context, owner, name string, number int) error {
	c.setContext(ctx)

	repoPath := fmt.Sprintf("/repos/%s/%s", owner, name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", repoPath)
	repo, resp, err := c.sdk.GetRepo(owner, name)
	if err != nil {
		return forgejoError(http.MethodGet, repoPath, resp, err)
	}
	style := repo.DefaultMergeStyle
	if style == "" {
		style = gitea.MergeStyleMerge
	}

	mergePath := fmt.Sprintf("/repos/%s/%s/pulls/%d/merge", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodPost, "url", mergePath)
	merged, resp, err := c.sdk.MergePullRequest(owner, name, int64(number), gitea.MergePullRequestOption{Style: style})
	if err != nil {
		return forgejoError(http.MethodPost, mergePath, resp, err)
	}
	// getStatusCode (what MergePullRequest is built on) reports a
	// non-2xx status as merged == false with a nil error rather than an
	// error — the body's own reason is already gone by the time this
	// sees resp, since getStatusCode closes it. All that's left to
	// classify by is the status code itself.
	if !merged {
		status := http.StatusBadGateway
		if resp != nil {
			status = resp.StatusCode
		}
		wrapped := fmt.Errorf("forgejo: %s %s: merge rejected (status %d)", http.MethodPost, mergePath, status)
		return &dashboard.ClientError{Kind: forgeErrorKind(status), Err: wrapped}
	}
	return nil
}

// UpdateBranch implements dashboard.BranchUpdater: merges owner/name#number's
// base branch into its head branch, bringing it up to date. Forgejo's SDK
// call is synchronous — accepted is always false here — unlike GitHub's
// async equivalent.
func (c *Client) UpdateBranch(ctx context.Context, owner, name string, number int) (bool, error) {
	c.setContext(ctx)
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/update", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodPost, "url", path)
	resp, err := c.sdk.UpdatePullRequest(owner, name, int64(number))
	if err != nil {
		return false, forgejoError(http.MethodPost, path, resp, err)
	}
	return false, nil
}

// AddLabel implements dashboard.PullRequestLabeler: adds label to
// owner/name#number — Renovate's own rebase/retry trigger on this forge.
// Forgejo's AddIssueLabels takes label IDs, not names (unlike GitHub's
// equivalent), so this looks the repo's own labels up first to resolve
// label to its ID. A repo with no label by that name fails informatively
// rather than silently doing nothing — Renovate doesn't create the label
// itself, the repo owner (or Renovate's own onboarding) does.
func (c *Client) AddLabel(ctx context.Context, owner, name string, number int, label string) error {
	c.setContext(ctx)

	labelsPath := fmt.Sprintf("/repos/%s/%s/labels", owner, name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", labelsPath)
	labels, resp, err := c.sdk.ListRepoLabels(owner, name, gitea.ListLabelsOptions{})
	if err != nil {
		return forgejoError(http.MethodGet, labelsPath, resp, err)
	}

	var id int64
	found := false
	for _, l := range labels {
		if l.Name == label {
			id = l.ID
			found = true
			break
		}
	}
	if !found {
		wrapped := fmt.Errorf("forgejo: no label %q on %s/%s — create it on the repo first", label, owner, name)
		return &dashboard.ClientError{Kind: dashboard.ForgeErrorNotFound, Err: wrapped}
	}

	addPath := fmt.Sprintf("/repos/%s/%s/issues/%d/labels", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodPost, "url", addPath)
	if _, resp, err := c.sdk.AddIssueLabels(owner, name, int64(number), gitea.IssueLabelsOption{Labels: []int64{id}}); err != nil {
		return forgejoError(http.MethodPost, addPath, resp, err)
	}
	return nil
}

// ListRepos returns the repositories this Client is configured to track —
// see NewClient for the two modes.
func (c *Client) ListRepos(ctx context.Context) ([]dashboard.RepoRef, error) {
	switch {
	case c.token != "":
		return c.listWriteRepos(ctx)
	case c.username != "":
		return c.listPublicRepos(ctx)
	default:
		return nil, errors.New("forgejo: neither a token nor a username is configured")
	}
}

func repoRef(r *gitea.Repository) dashboard.RepoRef {
	owner := ""
	if r.Owner != nil {
		owner = r.Owner.UserName
	}
	return dashboard.RepoRef{
		FullName:          r.FullName,
		Owner:             owner,
		Name:              r.Name,
		URL:               r.HTMLURL,
		CanManageWebhooks: r.Permissions != nil && r.Permissions.Admin,
	}
}

func hasPushAccess(r *gitea.Repository) bool {
	return r.Permissions != nil && r.Permissions.Push
}

// listWriteRepos returns every repository the token can push to, across
// every page.
func (c *Client) listWriteRepos(ctx context.Context) ([]dashboard.RepoRef, error) {
	c.setContext(ctx)
	var repos []dashboard.RepoRef
	opt := gitea.ListReposOptions{ListOptions: gitea.ListOptions{PageSize: pageLimit}}

	for {
		slog.Debug("forgejo request", "method", http.MethodGet, "url", "/user/repos")
		batch, resp, err := c.sdk.ListMyRepos(opt)
		if err != nil {
			return nil, forgejoError(http.MethodGet, "/user/repos", resp, err)
		}
		for _, r := range batch {
			if !hasPushAccess(r) || r.Archived || r.Fork || r.Mirror {
				continue
			}
			repos = append(repos, repoRef(r))
		}
		if resp.NextPage == 0 {
			break
		}
		opt.Page = resp.NextPage
	}
	return repos, nil
}

// listPublicRepos returns every public repository username owns on this
// instance, with no authentication at all.
func (c *Client) listPublicRepos(ctx context.Context) ([]dashboard.RepoRef, error) {
	c.setContext(ctx)
	var repos []dashboard.RepoRef
	opt := gitea.ListReposOptions{ListOptions: gitea.ListOptions{PageSize: pageLimit}}
	path := fmt.Sprintf("/users/%s/repos", c.username)

	for {
		slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
		batch, resp, err := c.sdk.ListUserRepos(c.username, opt)
		if err != nil {
			return nil, forgejoError(http.MethodGet, path, resp, err)
		}
		for _, r := range batch {
			if r.Archived || r.Fork || r.Mirror {
				continue
			}
			repos = append(repos, repoRef(r))
		}
		if resp.NextPage == 0 {
			break
		}
		opt.Page = resp.NextPage
	}
	return repos, nil
}

func toLabels(labels []*gitea.Label) []dashboard.Label {
	out := make([]dashboard.Label, 0, len(labels))
	for _, l := range labels {
		out = append(out, dashboard.Label{Name: l.Name, Color: l.Color})
	}
	return out
}

func posterLogin(u *gitea.User) string {
	if u == nil {
		return ""
	}
	return u.UserName
}

// mergeStatusFromMergeable deliberately maps false to MergeBlocked, not
// MergeConflicting: Forgejo computes this field via a background queue
// and multiple upstream Gitea issues (go-gitea/gitea#22578, #25849) show
// it can lag or get stuck stale, so a false here isn't confident enough
// to assert a real conflict, only that something is stopping the merge.
// See design.md's Decisions in
// openspec/changes/archive/*/show-pr-merge-status.
func mergeStatusFromMergeable(mergeable bool) dashboard.MergeStatus {
	if mergeable {
		return dashboard.MergeMergeable
	}
	return dashboard.MergeBlocked
}

// isBehind reports whether p's base branch has moved since p's own
// merge-base was computed — Base.Sha is refetched live on every request
// (confirmed against a real instance: it changed after pushing a new
// commit to the base branch), while MergeBase stays fixed at the original
// common ancestor, so the two diverging is exactly "behind." Deliberately
// not read from p.Mergeable: that field didn't flip to false in the same
// experiment, so it's not a reliable signal for this on its own.
func isBehind(p *gitea.PullRequest) bool {
	if p.Base == nil || p.Base.Sha == "" || p.MergeBase == "" {
		return false
	}
	return p.Base.Sha != p.MergeBase
}

// ListOpenPullRequests returns every open pull request against repo, with
// CI already resolved. repo is owner-qualified ("alrayyes/tempus-fugit").
func (c *Client) ListOpenPullRequests(ctx context.Context, owner, name, repo string) ([]dashboard.PullRequest, error) {
	c.setContext(ctx)
	var prs []dashboard.PullRequest
	path := fmt.Sprintf("/repos/%s/%s/pulls", owner, name)
	opt := gitea.ListPullRequestsOptions{State: gitea.StateOpen, ListOptions: gitea.ListOptions{PageSize: pageLimit}}

	for {
		slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
		batch, resp, err := c.sdk.ListRepoPullRequests(owner, name, opt)
		if err != nil {
			return nil, forgejoError(http.MethodGet, path, resp, err)
		}
		for _, p := range batch {
			sha := ""
			if p.Head != nil {
				sha = p.Head.Sha
			}
			ci, err := c.ciStatus(ctx, owner, name, sha)
			if err != nil {
				ci = dashboard.CINone
			}
			var created, updated time.Time
			if p.Created != nil {
				created = *p.Created
			}
			if p.Updated != nil {
				updated = *p.Updated
			}
			prs = append(prs, dashboard.PullRequest{
				Forge:       dashboard.ForgeForgejo,
				Repo:        repo,
				Number:      int(p.Index),
				Title:       p.Title,
				URL:         p.HTMLURL,
				Author:      posterLogin(p.Poster),
				Draft:       p.Draft,
				Labels:      toLabels(p.Labels),
				CreatedAt:   created,
				UpdatedAt:   updated,
				CI:          ci,
				MergeStatus: mergeStatusFromMergeable(p.Mergeable),
				Behind:      isBehind(p),
				// No read capability for this in the SDK at all — only
				// write-side schedule/cancel verbs
				// (MergePullRequestOption.MergeWhenChecksSucceed,
				// CancelScheduledAutoMerge), nothing that reports current
				// state. nil here means "this forge can't say," not "not
				// enabled."
				AutoMergeEnabled: nil,
			})
		}
		if resp.NextPage == 0 {
			break
		}
		opt.Page = resp.NextPage
	}
	return prs, nil
}

// ListOpenIssues returns every open issue against repo. Forgejo's issues
// endpoint takes type=issues to exclude pull requests server-side, unlike
// GitHub's equivalent — no client-side filtering needed here.
func (c *Client) ListOpenIssues(ctx context.Context, owner, name, repo string) ([]dashboard.Issue, error) {
	c.setContext(ctx)
	var issues []dashboard.Issue
	path := fmt.Sprintf("/repos/%s/%s/issues", owner, name)
	opt := gitea.ListIssueOption{State: gitea.StateOpen, Type: gitea.IssueTypeIssue, ListOptions: gitea.ListOptions{PageSize: pageLimit}}

	for {
		slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
		batch, resp, err := c.sdk.ListRepoIssues(owner, name, opt)
		if err != nil {
			return nil, forgejoError(http.MethodGet, path, resp, err)
		}
		for _, i := range batch {
			issues = append(issues, dashboard.Issue{
				Forge:     dashboard.ForgeForgejo,
				Repo:      repo,
				Number:    int(i.Index),
				Title:     i.Title,
				URL:       i.HTMLURL,
				Author:    posterLogin(i.Poster),
				Labels:    toLabels(i.Labels),
				CreatedAt: i.Created,
				UpdatedAt: i.Updated,
			})
		}
		if resp.NextPage == 0 {
			break
		}
		opt.Page = resp.NextPage
	}
	return issues, nil
}

// ciStatus resolves the combined commit status for sha, which Forgejo
// updates for both external CI and its own Actions runs.
func (c *Client) ciStatus(ctx context.Context, owner, name, sha string) (dashboard.CIStatus, error) {
	if sha == "" {
		return dashboard.CINone, nil
	}
	c.setContext(ctx)

	path := fmt.Sprintf("/repos/%s/%s/commits/%s/status", owner, name, sha)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	combined, resp, err := c.sdk.GetCombinedStatus(owner, name, sha)
	if err != nil {
		return dashboard.CINone, forgejoError(http.MethodGet, path, resp, err)
	}
	return statusFromCombinedState(combined.State), nil
}

func statusFromCombinedState(state gitea.StatusState) dashboard.CIStatus {
	switch state {
	case gitea.StatusSuccess:
		return dashboard.CISuccess
	case gitea.StatusFailure, gitea.StatusError:
		return dashboard.CIFailure
	case gitea.StatusPending:
		return dashboard.CIPending
	case gitea.StatusWarning:
		// Neither a clean pass nor a hard failure (e.g. a non-blocking
		// check complained) — closer to "still needs a look" than green.
		return dashboard.CIPending
	default:
		return dashboard.CINone
	}
}
