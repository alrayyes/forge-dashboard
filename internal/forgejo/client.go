// Package forgejo is a thin client for the pieces of the Forgejo API
// (Gitea-compatible) forge-dashboard needs — the same shape as
// internal/github, against a different API under a self-hosted host.
package forgejo

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

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
	httpClient *http.Client
	baseURL    string
	token      string
	username   string
}

// NewClient returns a Client against instanceURL (e.g.
// "https://git.higherlearning.eu"). With token set, it authenticates as
// that user and ListRepos returns every repo the token can push to,
// private included. With token empty and username set, every request
// goes out unauthenticated and ListRepos returns only username's public
// repos on that instance.
func NewClient(instanceURL, token, username string) *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		baseURL:    strings.TrimRight(instanceURL, "/") + "/api/v1",
		token:      token,
		username:   username,
	}
}

func (c *Client) get(ctx context.Context, path string, query url.Values, out any) error {
	u := c.baseURL + path
	if query != nil {
		u += "?" + query.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if c.token != "" {
		// Forgejo/Gitea's own personal-access-token scheme, distinct from
		// GitHub's "Bearer" — see the Forgejo API docs' authentication
		// section.
		req.Header.Set("Authorization", "token "+c.token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("forgejo: GET %s: unexpected status %s", path, resp.Status)
	}

	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

type repoJSON struct {
	FullName string `json:"full_name"`
	Name     string `json:"name"`
	Owner    struct {
		Login string `json:"login"`
	} `json:"owner"`
	Permissions struct {
		Push bool `json:"push"`
	} `json:"permissions"`
	Archived bool `json:"archived"`
	Fork     bool `json:"fork"`
	Mirror   bool `json:"mirror"`
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
		return nil, fmt.Errorf("forgejo: neither a token nor a username is configured")
	}
}

// listWriteRepos returns every repository the token can push to, across
// every page.
func (c *Client) listWriteRepos(ctx context.Context) ([]dashboard.RepoRef, error) {
	var repos []dashboard.RepoRef

	for page := 1; ; page++ {
		var batch []repoJSON
		q := url.Values{"limit": {strconv.Itoa(pageLimit)}, "page": {strconv.Itoa(page)}}
		if err := c.get(ctx, "/user/repos", q, &batch); err != nil {
			return nil, err
		}
		for _, r := range batch {
			if !r.Permissions.Push || r.Archived || r.Fork || r.Mirror {
				continue
			}
			repos = append(repos, dashboard.RepoRef{FullName: r.FullName, Owner: r.Owner.Login, Name: r.Name})
		}
		if len(batch) < pageLimit {
			break
		}
	}
	return repos, nil
}

// listPublicRepos returns every public repository username owns on this
// instance, with no authentication at all.
func (c *Client) listPublicRepos(ctx context.Context) ([]dashboard.RepoRef, error) {
	var repos []dashboard.RepoRef

	for page := 1; ; page++ {
		var batch []repoJSON
		q := url.Values{"limit": {strconv.Itoa(pageLimit)}, "page": {strconv.Itoa(page)}}
		path := fmt.Sprintf("/users/%s/repos", c.username)
		if err := c.get(ctx, path, q, &batch); err != nil {
			return nil, err
		}
		for _, r := range batch {
			if r.Archived || r.Fork || r.Mirror {
				continue
			}
			repos = append(repos, dashboard.RepoRef{FullName: r.FullName, Owner: r.Owner.Login, Name: r.Name})
		}
		if len(batch) < pageLimit {
			break
		}
	}
	return repos, nil
}

type userJSON struct {
	Login string `json:"login"`
}

type labelJSON struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

type pullJSON struct {
	Number    int         `json:"number"`
	Title     string      `json:"title"`
	HTMLURL   string      `json:"html_url"`
	Draft     bool        `json:"draft"`
	User      userJSON    `json:"user"`
	Labels    []labelJSON `json:"labels"`
	CreatedAt time.Time   `json:"created_at"`
	UpdatedAt time.Time   `json:"updated_at"`
	Head      struct {
		SHA string `json:"sha"`
	} `json:"head"`
}

func toLabels(labels []labelJSON) []dashboard.Label {
	out := make([]dashboard.Label, 0, len(labels))
	for _, l := range labels {
		out = append(out, dashboard.Label{Name: l.Name, Color: l.Color})
	}
	return out
}

// ListOpenPullRequests returns every open pull request against repo, with
// CI already resolved. repo is owner-qualified ("alrayyes/tempus-fugit").
func (c *Client) ListOpenPullRequests(ctx context.Context, owner, name, repo string) ([]dashboard.PullRequest, error) {
	var prs []dashboard.PullRequest

	for page := 1; ; page++ {
		var batch []pullJSON
		q := url.Values{"state": {"open"}, "limit": {strconv.Itoa(pageLimit)}, "page": {strconv.Itoa(page)}}
		path := fmt.Sprintf("/repos/%s/%s/pulls", owner, name)
		if err := c.get(ctx, path, q, &batch); err != nil {
			return nil, err
		}
		for _, p := range batch {
			ci, err := c.ciStatus(ctx, owner, name, p.Head.SHA)
			if err != nil {
				ci = dashboard.CINone
			}
			prs = append(prs, dashboard.PullRequest{
				Forge:     dashboard.ForgeForgejo,
				Repo:      repo,
				Number:    p.Number,
				Title:     p.Title,
				URL:       p.HTMLURL,
				Author:    p.User.Login,
				Draft:     p.Draft,
				Labels:    toLabels(p.Labels),
				CreatedAt: p.CreatedAt,
				UpdatedAt: p.UpdatedAt,
				CI:        ci,
			})
		}
		if len(batch) < pageLimit {
			break
		}
	}
	return prs, nil
}

type issueJSON struct {
	Number    int         `json:"number"`
	Title     string      `json:"title"`
	HTMLURL   string      `json:"html_url"`
	User      userJSON    `json:"user"`
	Labels    []labelJSON `json:"labels"`
	CreatedAt time.Time   `json:"created_at"`
	UpdatedAt time.Time   `json:"updated_at"`
}

// ListOpenIssues returns every open issue against repo. Forgejo's issues
// endpoint takes type=issues to exclude pull requests server-side, unlike
// GitHub's equivalent — no client-side filtering needed here.
func (c *Client) ListOpenIssues(ctx context.Context, owner, name, repo string) ([]dashboard.Issue, error) {
	var issues []dashboard.Issue

	for page := 1; ; page++ {
		var batch []issueJSON
		q := url.Values{
			"state": {"open"}, "type": {"issues"},
			"limit": {strconv.Itoa(pageLimit)}, "page": {strconv.Itoa(page)},
		}
		path := fmt.Sprintf("/repos/%s/%s/issues", owner, name)
		if err := c.get(ctx, path, q, &batch); err != nil {
			return nil, err
		}
		for _, i := range batch {
			issues = append(issues, dashboard.Issue{
				Forge:     dashboard.ForgeForgejo,
				Repo:      repo,
				Number:    i.Number,
				Title:     i.Title,
				URL:       i.HTMLURL,
				Author:    i.User.Login,
				Labels:    toLabels(i.Labels),
				CreatedAt: i.CreatedAt,
				UpdatedAt: i.UpdatedAt,
			})
		}
		if len(batch) < pageLimit {
			break
		}
	}
	return issues, nil
}

type combinedStatusResponse struct {
	State string `json:"state"`
}

// ciStatus resolves the combined commit status for sha, which Forgejo
// updates for both external CI and its own Actions runs.
func (c *Client) ciStatus(ctx context.Context, owner, name, sha string) (dashboard.CIStatus, error) {
	if sha == "" {
		return dashboard.CINone, nil
	}

	var combined combinedStatusResponse
	path := fmt.Sprintf("/repos/%s/%s/commits/%s/status", owner, name, sha)
	if err := c.get(ctx, path, nil, &combined); err != nil {
		return dashboard.CINone, err
	}
	return statusFromCombinedState(combined.State), nil
}

func statusFromCombinedState(state string) dashboard.CIStatus {
	switch state {
	case "success":
		return dashboard.CISuccess
	case "failure", "error":
		return dashboard.CIFailure
	case "pending":
		return dashboard.CIPending
	case "warning":
		// Neither a clean pass nor a hard failure (e.g. a non-blocking
		// check complained) — closer to "still needs a look" than green.
		return dashboard.CIPending
	default:
		return dashboard.CINone
	}
}
