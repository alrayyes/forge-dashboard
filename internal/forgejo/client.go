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
	sdk      *gitea.Client
	token    string
	username string
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

// forgejoError turns a failed gitea SDK call into the reason a person
// reading the dashboard's forge-health error actually needs: the
// instance's own error message (already extracted from the response body
// by the SDK), plus a Retry-After wait (RFC 9110 §10.2.3) where a
// fronting proxy or the instance itself sent one — Forgejo has no
// built-in rate limiting of its own, but this still covers an instance
// sitting behind one that does. The SDK's *Response is populated even on
// a failed request, which is what makes the header still readable here.
func forgejoError(method, path string, resp *gitea.Response, err error) error {
	msg := err.Error()
	if resp != nil {
		if retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {
			msg += fmt.Sprintf(" (retry after %ss)", retryAfter)
		}
	}
	return fmt.Errorf("forgejo: %s %s: %s", method, path, msg)
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
	return dashboard.RepoRef{FullName: r.FullName, Owner: owner, Name: r.Name}
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
				Forge:     dashboard.ForgeForgejo,
				Repo:      repo,
				Number:    int(p.Index),
				Title:     p.Title,
				URL:       p.HTMLURL,
				Author:    posterLogin(p.Poster),
				Draft:     p.Draft,
				Labels:    toLabels(p.Labels),
				CreatedAt: created,
				UpdatedAt: updated,
				CI:        ci,
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
