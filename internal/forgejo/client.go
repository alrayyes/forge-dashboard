// Package forgejo is a client for the pieces of the Forgejo API
// (Gitea-compatible) forge-dashboard needs — the same shape as
// internal/github, against a different API under a self-hosted host.
// Driven by code.gitea.io/sdk/gitea, the official Gitea Go client and the
// one Forgejo's own API compatibility targets, rather than hand-rolled
// requests.
package forgejo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

var (
	// errForgeRefused introduces the reason Forgejo gave for refusing a call.
	errForgeRefused = errors.New("refused")
	// errLabelMissing is a rebase label the repo doesn't have.
	errLabelMissing = errors.New("label missing")
	// errNoForgejoAuth is a client with neither a token nor a username to list with.
	errNoForgejoAuth = errors.New("forgejo: neither a token nor a username is configured")
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
	// instanceURL and httpClient exist only for listActionRunJobs' own
	// raw-HTTP fallback — see its doc comment for why the SDK's typed
	// method can't be used for that one call. Trimmed the same way the
	// SDK trims its own internal c.url, so the two build identical
	// request URLs.
	instanceURL string
	httpClient  *http.Client

	// recorder persists a request_log entry for every outbound request
	// this Client makes (#482) — always non-nil (NewClient defaults it
	// to requestlog.NoopRecorder{}), so every call site can call it
	// unconditionally.
	recorder requestlog.Recorder

	// reviews caches each pull request's review state by its updated_at,
	// so the per-PR reviews call (see reviewState) only repeats when the
	// PR changed. Forgejo bumps updated_at when a review is submitted.
	reviewsMu sync.Mutex
	reviews   map[string]cachedReview
}

// cachedReview is one pull request's review state as of updatedAt.
type cachedReview struct {
	updatedAt time.Time
	state     *dashboard.ReviewState
}

// NewClient returns a Client against instanceURL (e.g.
// "https://git.higherlearning.eu"). With token set, it authenticates as
// that user and ListRepos returns every repo the token can push to,
// private included. With token empty and username set, every request
// goes out unauthenticated and ListRepos returns only username's public
// repos on that instance.
// recorder is variadic, not a plain trailing parameter, purely so every
// existing call site (tests included) keeps compiling unchanged (#482)
// — pass one to have every outbound request persisted, or omit it (or
// pass nil) to get requestlog.NoopRecorder{}, the same as before this
// parameter existed.
func NewClient(instanceURL, token, username string, recorder ...requestlog.Recorder) *Client {
	// A dedicated Transport, not the zero value's shared
	// http.DefaultTransport: httptest.Server.Close() calls
	// http.DefaultTransport.CloseIdleConnections() as a documented side
	// effect, which is process-wide, not scoped to the server being
	// closed. With every Client sharing that default, one parallel
	// test's server teardown could yank the connection out from under a
	// completely different Client's in-flight request against its own
	// httptest server — confirmed live as a flaky
	// "CloseIdleConnections called" failure in TestEnsureWebhook_*.
	httpClient := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{}}
	opts := []gitea.ClientOption{
		gitea.SetHTTPClient(httpClient),
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

	rec := requestlog.Recorder(requestlog.NoopRecorder{})
	if len(recorder) > 0 && recorder[0] != nil {
		rec = recorder[0]
	}

	return &Client{
		sdk:         sdk,
		token:       token,
		username:    username,
		instanceURL: strings.TrimSuffix(instanceURL, "/"),
		httpClient:  httpClient,
		recorder:    rec,
		reviews:     map[string]cachedReview{},
	}
}

// recordRequest builds and persists this call's own request_log entry
// via c.recorder — never let a Record failure affect the caller (see
// requestlog.Recorder's own doc comment): logged and otherwise
// swallowed. Forgejo reports no rate-limit budget of its own, so this
// client's entries never carry rate-limit fields (all left nil), unlike
// GitHub's.
func (c *Client) recordRequest(ctx context.Context, method, endpoint string, statusCode int, outcome string) {
	e := requestlog.Entry{
		LoggedAt:   time.Now().UTC(),
		Forge:      dashboard.ForgeForgejo,
		Method:     method,
		Endpoint:   endpoint,
		StatusCode: statusCode,
		Outcome:    outcome,
	}
	if err := c.recorder.Record(ctx, e); err != nil {
		slog.Warn("could not record outbound request", "forge", dashboard.ForgeForgejo, "error", err)
	}
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
	opt := gitea.ListHooksOptions{PageSize: pageLimit}

	for {
		slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
		hooks, resp, err := c.sdk.ListRepoHooks(owner, name, opt)
		if err != nil {
			return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
		}
		c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)
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
			return c.forgejoError(ctx, http.MethodPatch, path, resp, err)
		}
		c.recordRequest(ctx, http.MethodPatch, path, resp.StatusCode, requestlog.OutcomeSuccess)

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
		return c.forgejoError(ctx, http.MethodPost, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodPost, path, resp.StatusCode, requestlog.OutcomeSuccess)

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
// forgejoError is a method, not a free function, because it also
// persists this call's own request_log entry (#482) — it's the one
// choke point every REST call site's failure path already returns
// through, which makes it the natural place to do that rather than
// repeating the same call at every site.
func (c *Client) forgejoError(ctx context.Context, method, path string, resp *gitea.Response, err error) error {
	msg := err.Error()
	kind := dashboard.ForgeErrorUnreachable
	statusCode := 0
	var rateLimit *dashboard.RateLimit
	if resp != nil {
		if retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {
			msg += fmt.Sprintf(" (retry after %ss)", retryAfter)
		}
		kind = forgeErrorKind(resp.StatusCode)
		statusCode = resp.StatusCode
		if kind == dashboard.ForgeErrorRateLimited {
			rateLimit = rateLimitFromRetryAfter(resp.Header.Get("Retry-After"), time.Now())
		}
	}
	c.recordRequest(ctx, method, path, statusCode, string(kind))
	wrapped := fmt.Errorf("forgejo: %s %s: %w: %s", method, path, errForgeRefused, msg)

	return &dashboard.ClientError{Kind: kind, Err: wrapped, RateLimit: rateLimit}
}

// rateLimitFromRetryAfter turns a Retry-After header (RFC 9110 10.2.3: a
// number of seconds or an HTTP date) into the budget a refused action
// reports, so the refusal can say when to try again. Only ResetsAt is known,
// since Forgejo reports no budget of its own. Nil when the header is absent
// or isn't either form.
func rateLimitFromRetryAfter(header string, now time.Time) *dashboard.RateLimit {
	header = strings.TrimSpace(header)
	if header == "" {
		return nil
	}
	if seconds, err := strconv.Atoi(header); err == nil {
		if seconds < 0 {
			return nil
		}

		return &dashboard.RateLimit{ResetsAt: now.Add(time.Duration(seconds) * time.Second)}
	}
	if at, err := http.ParseTime(header); err == nil {
		return &dashboard.RateLimit{ResetsAt: at}
	}

	return nil
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
		return c.forgejoError(ctx, http.MethodGet, repoPath, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, repoPath, resp.StatusCode, requestlog.OutcomeSuccess)
	style := repo.DefaultMergeStyle
	if style == "" {
		style = gitea.MergeStyleMerge
	}

	mergePath := fmt.Sprintf("/repos/%s/%s/pulls/%d/merge", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodPost, "url", mergePath)
	mergeBody, err := json.Marshal(gitea.MergePullRequestOption{Style: style})
	if err != nil {
		return fmt.Errorf("forgejo: encode merge option: %w", err)
	}
	// Via rawRequest, not the SDK's own MergePullRequest — that's built
	// on getStatusCode, which discards the response body on any
	// non-2xx status. rawRequest reads it, so a rejected merge (a real
	// conflict, or the empty-commit case above) reports Forgejo's own
	// reason instead of a bare status code.
	if _, resp, err := c.rawRequest(ctx, http.MethodPost, mergePath, bytes.NewReader(mergeBody)); err != nil {
		return c.forgejoError(ctx, http.MethodPost, mergePath, resp, err)
	}

	return nil
}

// ReadPullRequestState implements dashboard.PullRequestStateReader via
// Forgejo's "Get a pull request". It reports merged, state and a single
// mergeable verdict, with no mergeable_state to say why a PR isn't
// mergeable. Gitea computes that flag from the merge check alone: false for
// a conflict, but also while the check is still running or has errored, and
// it ignores branch protection altogether. So an open, non-draft PR with a
// false flag is reported as ConflictUnconfirmed, and one with an empty diff
// (which Gitea also marks unmergeable) as Blocked. A missing review or
// check isn't visible here: the merge refusal's own text names it.
func (c *Client) ReadPullRequestState(ctx context.Context, owner, name string, number int) (dashboard.PullRequestState, error) {
	c.setContext(ctx)

	path := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	pr, resp, err := c.sdk.GetPullRequest(owner, name, int64(number))
	if err != nil {
		return dashboard.PullRequestState{}, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)

	closed := pr.State == gitea.StateClosed
	unmergeable := !closed && !pr.HasMerged && !pr.Mergeable

	return dashboard.PullRequestState{
		Merged:              pr.HasMerged,
		Closed:              closed,
		Draft:               !closed && pr.Draft,
		ConflictUnconfirmed: unmergeable && !isEmpty(pr),
		Blocked:             unmergeable && isEmpty(pr),
	}, nil
}

// ClosePullRequest implements dashboard.PullRequestCloser: closes
// owner/name#number without merging it. EditPullRequest goes through the
// SDK's own getParsedResponse, not the getStatusCode MergePullRequest and
// UpdateBranch are stuck with (see forgejoError's own callers above for
// why that matters) — Forgejo's real rejection reason, if any, reaches
// the caller here without needing rawRequest.
func (c *Client) ClosePullRequest(ctx context.Context, owner, name string, number int) error {
	c.setContext(ctx)

	path := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodPatch, "url", path)
	closed := gitea.StateClosed
	_, resp, err := c.sdk.EditPullRequest(owner, name, int64(number), gitea.EditPullRequestOption{State: &closed})
	if err != nil {
		return c.forgejoError(ctx, http.MethodPatch, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodPatch, path, resp.StatusCode, requestlog.OutcomeSuccess)

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
	// Via rawRequest, not the SDK's own UpdatePullRequest — see
	// MergePullRequest's own comment on why: same getStatusCode gap,
	// same lost-reason symptom.
	if _, resp, err := c.rawRequest(ctx, http.MethodPost, path, nil); err != nil {
		return false, c.forgejoError(ctx, http.MethodPost, path, resp, err)
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
		return c.forgejoError(ctx, http.MethodGet, labelsPath, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, labelsPath, resp.StatusCode, requestlog.OutcomeSuccess)

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
		wrapped := fmt.Errorf("forgejo: no label %q on %s/%s — create it on the repo first: %w", label, owner, name, errLabelMissing)

		return &dashboard.ClientError{Kind: dashboard.ForgeErrorNotFound, Err: wrapped}
	}

	addPath := fmt.Sprintf("/repos/%s/%s/issues/%d/labels", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodPost, "url", addPath)
	_, addResp, err := c.sdk.AddIssueLabels(owner, name, int64(number), gitea.IssueLabelsOption{Labels: []int64{id}})
	if err != nil {
		return c.forgejoError(ctx, http.MethodPost, addPath, addResp, err)
	}
	c.recordRequest(ctx, http.MethodPost, addPath, addResp.StatusCode, requestlog.OutcomeSuccess)

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
		return nil, errNoForgejoAuth
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
	opt := gitea.ListReposOptions{PageSize: pageLimit}

	for {
		slog.Debug("forgejo request", "method", http.MethodGet, "url", "/user/repos")
		batch, resp, err := c.sdk.ListMyRepos(opt)
		if err != nil {
			return nil, c.forgejoError(ctx, http.MethodGet, "/user/repos", resp, err)
		}
		c.recordRequest(ctx, http.MethodGet, "/user/repos", resp.StatusCode, requestlog.OutcomeSuccess)
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
	opt := gitea.ListReposOptions{PageSize: pageLimit}
	path := fmt.Sprintf("/users/%s/repos", c.username)

	for {
		slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
		batch, resp, err := c.sdk.ListUserRepos(c.username, opt)
		if err != nil {
			return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
		}
		c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)
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

// isEmpty reports whether p's diff against its base is empty — nil on any
// of the three (an instance old enough not to report them, per dashboard
// .PullRequest.Empty's own doc comment) reads as false, not empty, so this
// never claims a diff is empty when it genuinely doesn't know.
func isEmpty(p *gitea.PullRequest) bool {
	if p.Additions == nil || p.Deletions == nil || p.ChangedFiles == nil {
		return false
	}

	return *p.Additions == 0 && *p.Deletions == 0 && *p.ChangedFiles == 0
}

// reviewState resolves p's review state. The requested-reviewer count is
// free on the PR object, but approvals and changes requested need one
// reviews call (GET /repos/{owner}/{repo}/pulls/{index}/reviews), so that
// call is made only for non-draft PRs and cached against updated_at: a
// steady-state refresh costs no extra requests, and each changed PR costs
// one. A failed call returns nil (unknown) rather than guessing "none".
func (c *Client) reviewState(ctx context.Context, owner, name string, p *gitea.PullRequest) *dashboard.ReviewState {
	if p.Draft {
		return nil
	}
	var updated time.Time
	if p.Updated != nil {
		updated = *p.Updated
	}
	key := reviewKey(owner, name, p.Index)

	c.reviewsMu.Lock()
	hit, ok := c.reviews[key]
	c.reviewsMu.Unlock()
	if ok && hit.updatedAt.Equal(updated) {
		return hit.state
	}

	reviews, err := c.listReviews(ctx, owner, name, p.Index)
	if err != nil {
		slog.Debug("forgejo reviews unavailable", "repo", owner+"/"+name, "pr", p.Index, "err", err)

		return nil
	}

	approvals, changes := countLatestReviews(reviews)
	requested := len(p.RequestedReviewers) + len(p.RequestedReviewersTeams)
	state := &dashboard.ReviewState{
		Decision:           dashboard.DeriveReviewDecision(approvals, changes, requested),
		Approvals:          approvals,
		RequestedReviewers: requested,
	}

	c.reviewsMu.Lock()
	c.reviews[key] = cachedReview{updatedAt: updated, state: state}
	c.reviewsMu.Unlock()

	return state
}

// countLatestReviews counts approvals and change requests, taking each
// reviewer's latest opinionated, non-dismissed review and nothing earlier.
func countLatestReviews(reviews []*gitea.PullReview) (approvals, changes int) {
	sort.SliceStable(reviews, func(i, j int) bool { return reviews[i].Submitted.Before(reviews[j].Submitted) })
	latest := map[string]gitea.ReviewStateType{}
	for _, r := range reviews {
		if r.Dismissed || (r.State != gitea.ReviewStateApproved && r.State != gitea.ReviewStateRequestChanges) {
			continue
		}
		who := ""
		switch {
		case r.Reviewer != nil:
			who = "u:" + r.Reviewer.UserName
		case r.ReviewerTeam != nil:
			who = "t:" + r.ReviewerTeam.Name
		}
		latest[who] = r.State
	}
	for _, st := range latest {
		if st == gitea.ReviewStateApproved {
			approvals++
		} else {
			changes++
		}
	}

	return approvals, changes
}

func reviewKey(owner, name string, index int64) string {
	return fmt.Sprintf("%s/%s#%d", owner, name, index)
}

// pruneReviews drops the cached review state of owner/name's PRs that are no
// longer open, so the cache stays bounded by the open PRs rather than
// growing with every PR that ever closed. open holds the review keys the
// latest complete listing returned.
func (c *Client) pruneReviews(owner, name string, open map[string]struct{}) {
	prefix := fmt.Sprintf("%s/%s#", owner, name)

	c.reviewsMu.Lock()
	defer c.reviewsMu.Unlock()
	for key := range c.reviews {
		if _, ok := open[key]; !ok && strings.HasPrefix(key, prefix) {
			delete(c.reviews, key)
		}
	}
}

// listReviews pages through one PR's reviews.
func (c *Client) listReviews(ctx context.Context, owner, name string, index int64) ([]*gitea.PullReview, error) {
	c.setContext(ctx)
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/reviews", owner, name, index)
	opt := gitea.ListPullReviewsOptions{PageSize: pageLimit}
	var all []*gitea.PullReview
	for {
		slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
		batch, resp, err := c.sdk.ListPullReviews(owner, name, index, opt)
		if err != nil {
			return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
		}
		c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)
		all = append(all, batch...)
		if resp.NextPage == 0 {
			return all, nil
		}
		opt.Page = resp.NextPage
	}
}

// toPullRequest maps one Forgejo pull request, resolving its CI and its
// review state.
func (c *Client) toPullRequest(ctx context.Context, owner, name, repo string, p *gitea.PullRequest) dashboard.PullRequest {
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

	return dashboard.PullRequest{
		Forge:                   dashboard.ForgeForgejo,
		Repo:                    repo,
		Number:                  int(p.Index),
		Title:                   p.Title,
		URL:                     p.HTMLURL,
		Author:                  posterLogin(p.Poster),
		Draft:                   p.Draft,
		Labels:                  toLabels(p.Labels),
		CreatedAt:               created,
		UpdatedAt:               updated,
		CI:                      ci,
		MergeStatus:             mergeStatusFromMergeable(p.Mergeable),
		Behind:                  isBehind(p),
		HeadSHA:                 sha,
		BaseBranch:              branchRef(p.Base),
		HeadBranch:              branchRef(p.Head),
		CrossRepository:         p.Head != nil && p.Base != nil && p.Head.RepoID != p.Base.RepoID,
		RequestedReviewerLogins: requestedLogins(p),
		Empty:                   isEmpty(p),
		// No read capability for this in the SDK at all — only
		// write-side schedule/cancel verbs
		// (MergePullRequestOption.MergeWhenChecksSucceed,
		// CancelScheduledAutoMerge), nothing that reports current
		// state. nil here means "this forge can't say," not "not
		// enabled."
		AutoMergeEnabled: nil,
		Review:           c.reviewState(ctx, owner, name, p),
	}
}

// ListOpenPullRequests returns every open pull request against repo, with
// CI already resolved. repo is owner-qualified ("alrayyes/tempus-fugit").
func (c *Client) ListOpenPullRequests(ctx context.Context, owner, name, repo string) ([]dashboard.PullRequest, error) {
	c.setContext(ctx)
	var prs []dashboard.PullRequest
	path := fmt.Sprintf("/repos/%s/%s/pulls", owner, name)
	opt := gitea.ListPullRequestsOptions{State: gitea.StateOpen, PageSize: pageLimit}
	open := map[string]struct{}{}

	for {
		slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
		batch, resp, err := c.sdk.ListRepoPullRequests(owner, name, opt)
		if err != nil {
			return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
		}
		c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)
		for _, p := range batch {
			open[reviewKey(owner, name, p.Index)] = struct{}{}
			prs = append(prs, c.toPullRequest(ctx, owner, name, repo, p))
		}
		if resp.NextPage == 0 {
			break
		}
		opt.Page = resp.NextPage
	}
	c.pruneReviews(owner, name, open)

	return prs, nil
}

// ListOpenIssues returns every open issue against repo. Forgejo's issues
// endpoint takes type=issues to exclude pull requests server-side, unlike
// GitHub's equivalent — no client-side filtering needed here.
func (c *Client) ListOpenIssues(ctx context.Context, owner, name, repo string) ([]dashboard.Issue, error) {
	c.setContext(ctx)
	var issues []dashboard.Issue
	path := fmt.Sprintf("/repos/%s/%s/issues", owner, name)
	opt := gitea.ListIssueOption{State: gitea.StateOpen, Type: gitea.IssueTypeIssue, PageSize: pageLimit}

	for {
		slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
		batch, resp, err := c.sdk.ListRepoIssues(owner, name, opt)
		if err != nil {
			return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
		}
		c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)
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
		return dashboard.CINone, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)

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

// ListChecks implements dashboard.PullRequestChecker: lists every
// individual job across every Actions run against owner/name#number's
// head commit, falling back to the legacy combined-status API's own
// per-check Statuses when this instance reports no Actions runs for that
// commit at all (Actions disabled, or an instance old enough to lack the
// /actions/runs route family — ListRepoActionRuns hits the wire for real
// rather than failing fast on a version check, since this client disables
// the SDK's version gates; see NewClient's own SetGiteaVersion("")
// comment). A real fetch error (permission, rate limit) still propagates
// instead of being swallowed into that same fallback.
func (c *Client) ListChecks(ctx context.Context, owner, name string, number int) ([]dashboard.Check, error) {
	c.setContext(ctx)

	prPath := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", prPath)
	pr, resp, err := c.sdk.GetPullRequest(owner, name, int64(number))
	if err != nil {
		return nil, c.forgejoError(ctx, http.MethodGet, prPath, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, prPath, resp.StatusCode, requestlog.OutcomeSuccess)
	var sha string
	if pr.Head != nil {
		sha = pr.Head.Sha
	}
	if sha == "" {
		return nil, nil
	}
	var base string
	if pr.Base != nil {
		base = pr.Base.Ref
	}
	checks, probes, err := c.listChecksForSHA(ctx, owner, name, sha)
	if err != nil {
		return nil, err
	}
	c.markRequired(ctx, owner, name, base, checks, probes)

	return checks, nil
}

// listChecksForSHA is ListChecks' per-commit half: every Actions job for
// the commit, or the legacy commit statuses when there are none. The
// parallel probes slice holds, per check, the longer commit-status context
// an Actions job reports under ("<workflow> / <job> (<event>)"), or ""
// for a legacy status whose name already is its context.
func (c *Client) listChecksForSHA(ctx context.Context, owner, name, sha string) ([]dashboard.Check, []string, error) {
	runsPath := fmt.Sprintf("/repos/%s/%s/actions/runs", owner, name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", runsPath)
	runs, runsResp, err := c.sdk.ListRepoActionRuns(owner, name, gitea.ListRepoActionRunsOptions{
		PageSize: pageLimit,
		HeadSHA:  sha,
	})
	if err != nil {
		if runsResp != nil && runsResp.StatusCode == http.StatusNotFound {
			// A real, completed request — recorded on its own rather
			// than silently absorbed into the fallback it triggers,
			// even though the app itself treats this 404 as expected
			// (an instance too old for /actions/runs) rather than an
			// error worth surfacing.
			c.recordRequest(ctx, http.MethodGet, runsPath, runsResp.StatusCode, string(dashboard.ForgeErrorNotFound))

			return c.statusChecks(ctx, owner, name, sha)
		}

		return nil, nil, c.forgejoError(ctx, http.MethodGet, runsPath, runsResp, err)
	}
	c.recordRequest(ctx, http.MethodGet, runsPath, runsResp.StatusCode, requestlog.OutcomeSuccess)
	if len(runs.WorkflowRuns) == 0 {
		return c.statusChecks(ctx, owner, name, sha)
	}

	var checks []dashboard.Check
	var probes []string
	for _, run := range runs.WorkflowRuns {
		jobs, err := c.listActionRunJobs(ctx, owner, name, run.ID)
		if err != nil {
			return nil, nil, err
		}
		for _, j := range jobs {
			checks = append(checks, dashboard.Check{
				Name:  j.Name,
				State: checkStateFromWorkflowStatus(j.Status),
				URL:   j.HTMLURL,
			})
			probes = append(probes, workflowContext(run, j.Name))
		}
	}

	return checks, probes, nil
}

// statusChecks wraps checksFromCombinedStatus for listChecksForSHA's
// three-value return.
func (c *Client) statusChecks(ctx context.Context, owner, name, sha string) ([]dashboard.Check, []string, error) {
	checks, err := c.checksFromCombinedStatus(ctx, owner, name, sha)

	return checks, nil, err
}

// checksFromCombinedStatus is ListChecks' own fallback: the legacy
// commit-status API's Statuses are real per-check entries too (context,
// state, target URL), not a second aggregate — the same shape GitHub's
// own combined-status fallback already uses for the equivalent case.
func (c *Client) checksFromCombinedStatus(ctx context.Context, owner, name, sha string) ([]dashboard.Check, error) {
	c.setContext(ctx)

	path := fmt.Sprintf("/repos/%s/%s/commits/%s/status", owner, name, sha)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	combined, resp, err := c.sdk.GetCombinedStatus(owner, name, sha)
	if err != nil {
		return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)
	checks := make([]dashboard.Check, 0, len(combined.Statuses))
	for _, s := range combined.Statuses {
		checks = append(checks, dashboard.Check{
			Name:  s.Context,
			State: checkStateFromCombinedState(s.State),
			URL:   s.TargetURL,
		})
	}

	return checks, nil
}

func checkStateFromCombinedState(state gitea.StatusState) dashboard.CheckState {
	switch state {
	case gitea.StatusSuccess:
		return dashboard.CheckSuccess
	case gitea.StatusFailure, gitea.StatusError:
		return dashboard.CheckFailure
	default: // pending, warning
		return dashboard.CheckRunning
	}
}

// checkStateFromWorkflowStatus maps one Actions job's own Status field to
// a CheckState. Gitea/Forgejo Actions runs, jobs and steps report one of
// eight statuses directly (unknown, waiting, running, success, failure,
// cancelled, skipped, blocked) rather than GitHub's separate
// status/conclusion pair, so this reads Status alone — ActionWorkflowJob's
// own Conclusion field is left unused here since its real population
// isn't confirmed against a live instance.
func checkStateFromWorkflowStatus(status string) dashboard.CheckState {
	switch status {
	case "success":
		return dashboard.CheckSuccess
	case "failure":
		return dashboard.CheckFailure
	case "cancelled":
		return dashboard.CheckCancelled
	case "skipped":
		return dashboard.CheckSkipped
	case "running":
		return dashboard.CheckRunning
	default: // "waiting", "blocked", "unknown", or anything unrecognized
		return dashboard.CheckQueued
	}
}

// listActionRunJobs lists every job for runID, decoding leniently rather
// than trusting the gitea SDK's own typed ListRepoActionRunJobs. A real,
// newer Forgejo instance can answer this exact endpoint with a bare JSON
// array instead of the {"total_count":N,"jobs":[...]} wrapper
// ActionWorkflowJobsResponse expects — confirmed live in the sibling
// project alrayyes/pipeline-analytics (issue #123), hit against this same
// SDK version with this same client's version gates disabled (see
// NewClient's own SetGiteaVersion("") comment), which leaves nothing to
// protect the typed call from that mismatch. Decoding both shapes here,
// via a raw request the SDK's own private HTTP plumbing isn't exported
// for, sidesteps it instead of rediscovering it against a real instance.
func (c *Client) listActionRunJobs(ctx context.Context, owner, name string, runID int64) ([]*gitea.ActionWorkflowJob, error) {
	path := fmt.Sprintf("/repos/%s/%s/actions/runs/%d/jobs", owner, name, runID)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	body, resp, err := c.rawRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}

	var wrapped gitea.ActionWorkflowJobsResponse
	if jsonErr := json.Unmarshal(body, &wrapped); jsonErr == nil {
		return wrapped.Jobs, nil
	}
	var bare []*gitea.ActionWorkflowJob
	if jsonErr := json.Unmarshal(body, &bare); jsonErr != nil {
		return nil, fmt.Errorf("forgejo: unmarshal action run jobs response: %w", jsonErr)
	}

	return bare, nil
}

// rawRequest is a plain authenticated request against this instance,
// bypassing the gitea SDK entirely. Two different gaps in the SDK need
// this, not one: listActionRunJobs, to decode a response body the SDK's
// own typed method can't be told to accept in both shapes it's known to
// return; and MergePullRequest/UpdatePullRequest, both built on the
// SDK's private getStatusCode, which closes the response body without
// ever reading it — Forgejo's own reason for rejecting a merge or
// update (confirmed live against a real instance: "the changes on this
// branch are already on the target branch, this will be an empty
// commit") never reached a caller, surfacing as a bare "unexpected
// status: N" with nothing a person could act on. Mirrors gitea.Client's
// own doRequest (same URL shape, same "token "+token header, same
// {"message": "..."} error-body convention its own handleResponse
// decodes) rather than inventing a different one.
func (c *Client) rawRequest(ctx context.Context, method, path string, body io.Reader) ([]byte, *gitea.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.instanceURL+"/api/v1"+path, body)
	if err != nil {
		return nil, nil, fmt.Errorf("forgejo: build request: %w", err)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "token "+c.token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	httpResp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("forgejo: %s %s: %w", method, path, err)
	}
	defer func() { _ = httpResp.Body.Close() }()
	respBody, err := io.ReadAll(httpResp.Body)
	resp := &gitea.Response{Response: httpResp}
	if err != nil {
		return nil, resp, fmt.Errorf("forgejo: read response body: %w", err)
	}
	if httpResp.StatusCode >= 300 {
		msg := rawRequestErrorMessage(respBody)
		if msg == "" {
			// Forgejo sometimes refuses with an empty reason, e.g. merging an
			// already-merged PR. Say the status, never the raw body.
			msg = httpResp.Status
		}

		return nil, resp, fmt.Errorf("%w: %s", errForgeRefused, msg)
	}
	// The success path's own recording — a failure here returns to the
	// caller, which persists its own entry via forgejoError(ctx, method,
	// path, resp, err) using this same resp/err, so recording only here
	// (not also on the two error returns above) keeps it at one entry
	// per call.
	c.recordRequest(ctx, method, path, httpResp.StatusCode, requestlog.OutcomeSuccess)

	return respBody, resp, nil
}

// rawRequestErrorMessage extracts Forgejo's own {"message": "..."}
// (the same envelope gitea.Client's own handleResponse decodes for
// every call that doesn't bypass it) and falls back to the raw,
// trimmed body when it isn't JSON at all — empty or plain text, same
// as handleResponse's own fallback.
func rawRequestErrorMessage(body []byte) string {
	var errBody struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &errBody); err == nil {
		// A JSON envelope with an empty message has nothing readable in
		// it; its other fields are just a swagger link.
		return errBody.Message
	}

	return strings.TrimSpace(string(body))
}

// workflowContext is the commit-status context Forgejo reports an Actions
// job under, as best the runs API lets us rebuild it: the workflow file's
// stem stands in for the workflow's own name (the API doesn't return the
// `name:` key), so a protection pattern naming that longer context only
// matches when the two agree.
func workflowContext(run *gitea.ActionWorkflowRun, job string) string {
	stem := strings.TrimSuffix(path.Base(run.Path), path.Ext(run.Path))

	return fmt.Sprintf("%s / %s (%s)", stem, job, run.Event)
}

// requiredPatterns is the status-check name patterns the branch's protection
// rule requires, or none when it has no rule or doesn't require checks.
func requiredPatterns(rules []*gitea.BranchProtection, base string) []*regexp.Regexp {
	var patterns []*regexp.Regexp
	if rule := protectionForBranch(rules, base); rule != nil && rule.EnableStatusCheck {
		for _, p := range rule.StatusCheckContexts {
			patterns = append(patterns, globRegexp(p, false))
		}
	}

	return patterns
}

// matchesAny reports whether s matches any of patterns.
func matchesAny(patterns []*regexp.Regexp, s string) bool {
	for _, re := range patterns {
		if re.MatchString(s) {
			return true
		}
	}

	return false
}

// markRequired sets Check.Required from the base branch's protection rule
// (enable_status_check + status_check_contexts, which are glob patterns).
// Listing protections needs admin on the repo, so a failure leaves every
// check's Required nil rather than guessing. With the list in hand, a
// branch no rule covers, or a rule without status checks, requires
// nothing. A legacy status is matched by its context. An Actions job is
// reported under a longer context than its job name that the API doesn't
// hand us in full, so it is required when a pattern matches either, and
// otherwise stays unknown: only a status check we can map is advisory.
func (c *Client) markRequired(ctx context.Context, owner, name, base string, checks []dashboard.Check, probes []string) {
	if base == "" || len(checks) == 0 {
		return
	}
	c.setContext(ctx)

	protPath := fmt.Sprintf("/repos/%s/%s/branch_protections", owner, name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", protPath)
	var opt gitea.ListBranchProtectionsOptions
	opt.PageSize = pageLimit
	rules, resp, err := c.sdk.ListBranchProtections(owner, name, opt)
	if err != nil {
		slog.Debug("forgejo branch protections unreadable, required stays unknown", "repo", owner+"/"+name, "branch", base, "error", err)

		return
	}
	c.recordRequest(ctx, http.MethodGet, protPath, resp.StatusCode, requestlog.OutcomeSuccess)

	patterns := requiredPatterns(rules, base)
	matches := func(s string) bool { return matchesAny(patterns, s) }
	for i := range checks {
		isJob := i < len(probes) && probes[i] != ""
		switch {
		case matches(checks[i].Name) || (isJob && matches(probes[i])):
			checks[i].Required = new(true)
		case !isJob:
			checks[i].Required = new(false)
		}
	}
}

// protectionForBranch picks the rule governing branch: an exact rule name
// first, then the first glob that matches (`*` within a path segment, `**`
// across them, as Forgejo's branch rules define it).
func protectionForBranch(rules []*gitea.BranchProtection, branch string) *gitea.BranchProtection {
	ruleName := func(r *gitea.BranchProtection) string {
		if r.RuleName != "" {
			return r.RuleName
		}

		return r.BranchName
	}
	for _, r := range rules {
		if ruleName(r) == branch {
			return r
		}
	}
	for _, r := range rules {
		if globRegexp(ruleName(r), true).MatchString(branch) {
			return r
		}
	}

	return nil
}

// globRegexp compiles a Forgejo glob to an anchored regexp. With
// segments, `*` stops at `/` and `**` crosses it (branch rule names);
// without, `*` matches anything (status check patterns).
func globRegexp(pattern string, segments bool) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		switch ch := pattern[i]; ch {
		case '*':
			doubled := i+1 < len(pattern) && pattern[i+1] == '*'
			switch {
			case doubled:
				i++
				b.WriteString(".*")
			case segments:
				b.WriteString("[^/]*")
			default:
				b.WriteString(".*")
			}
		case '?':
			if segments {
				b.WriteString("[^/]")
			} else {
				b.WriteString(".")
			}
		default:
			b.WriteString(regexp.QuoteMeta(string(ch)))
		}
	}
	b.WriteString("$")

	return regexp.MustCompile(b.String())
}

// requestedLogins lists the logins of the users asked to review p (#695).
// The list comes with the pull request itself, so even a draft has it. Teams
// have no login and are left out. Never nil.
func requestedLogins(p *gitea.PullRequest) []string {
	logins := make([]string, 0, len(p.RequestedReviewers))
	for _, u := range p.RequestedReviewers {
		if u != nil && u.UserName != "" {
			logins = append(logins, u.UserName)
		}
	}

	return logins
}

// branchRef is a pull request branch's name, empty when the forge sent none.
func branchRef(b *gitea.PRBranchInfo) string {
	if b == nil {
		return ""
	}

	return b.Ref
}
