// Package github is a thin client for the pieces of the GitHub REST API
// forge-dashboard needs: which repositories the token can write to, their
// open pull requests and issues, and combined CI status per pull request.
// It's hand-written against net/http rather than a generated SDK — the
// surface area needed is small enough that a client library would cost
// more to pin and understand than it saves.
package github

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

const defaultBaseURL = "https://api.github.com"

// perPage is the page size used for every paginated list call. 100 is
// GitHub's maximum, which keeps a ~100-repo account's repo listing to a
// single page.
const perPage = 100

// Client talks to the GitHub REST API, either as an authenticated user (a
// token) or anonymously against one user's public repositories (a
// username, no token at all).
type Client struct {
	httpClient *http.Client
	baseURL    string
	token      string
	username   string
}

// NewClient returns a Client. With token set, it authenticates as that
// user and ListRepos returns every repo the token can push to, private
// included. With token empty and username set, every request goes out
// unauthenticated and ListRepos returns only username's public repos —
// there's no "write access" to filter by without a credential, so this
// mode returns everything public GitHub already shows anyone.
// baseURL defaults to the real GitHub API; tests override it to point at
// an httptest.Server.
func NewClient(token, username, baseURL string) *Client {
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		baseURL:    baseURL,
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
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("github: GET %s: unexpected status %s", path, resp.Status)
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
		return nil, fmt.Errorf("github: neither a token nor a username is configured")
	}
}

// listWriteRepos returns every repository the token can push to, across
// every page.
func (c *Client) listWriteRepos(ctx context.Context) ([]dashboard.RepoRef, error) {
	var repos []dashboard.RepoRef

	for page := 1; ; page++ {
		var batch []repoJSON
		q := url.Values{
			"affiliation": {"owner,collaborator"},
			"per_page":    {strconv.Itoa(perPage)},
			"page":        {strconv.Itoa(page)},
		}
		if err := c.get(ctx, "/user/repos", q, &batch); err != nil {
			return nil, err
		}
		for _, r := range batch {
			if !r.Permissions.Push {
				continue
			}
			repos = append(repos, dashboard.RepoRef{FullName: r.FullName, Owner: r.Owner.Login, Name: r.Name})
		}
		if len(batch) < perPage {
			break
		}
	}
	return repos, nil
}

// listPublicRepos returns every public repository username owns, with no
// authentication at all — the same list anyone gets landing on
// github.com/username?tab=repositories.
func (c *Client) listPublicRepos(ctx context.Context) ([]dashboard.RepoRef, error) {
	var repos []dashboard.RepoRef

	for page := 1; ; page++ {
		var batch []repoJSON
		q := url.Values{
			"type":     {"owner"},
			"per_page": {strconv.Itoa(perPage)},
			"page":     {strconv.Itoa(page)},
		}
		path := fmt.Sprintf("/users/%s/repos", c.username)
		if err := c.get(ctx, path, q, &batch); err != nil {
			return nil, err
		}
		for _, r := range batch {
			repos = append(repos, dashboard.RepoRef{FullName: r.FullName, Owner: r.Owner.Login, Name: r.Name})
		}
		if len(batch) < perPage {
			break
		}
	}
	return repos, nil
}

type userJSON struct {
	Login string `json:"login"`
}

type labelJSON struct {
	Name string `json:"name"`
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

func labelNames(labels []labelJSON) []string {
	names := make([]string, 0, len(labels))
	for _, l := range labels {
		names = append(names, l.Name)
	}
	return names
}

// ListOpenPullRequests returns every open pull request against repo, with
// CI already resolved. repo is owner-qualified ("alrayyes/hush-hush").
func (c *Client) ListOpenPullRequests(ctx context.Context, owner, name, repo string) ([]dashboard.PullRequest, error) {
	var prs []dashboard.PullRequest

	for page := 1; ; page++ {
		var batch []pullJSON
		q := url.Values{
			"state":    {"open"},
			"per_page": {strconv.Itoa(perPage)},
			"page":     {strconv.Itoa(page)},
		}
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
				Forge:     dashboard.ForgeGitHub,
				Repo:      repo,
				Number:    p.Number,
				Title:     p.Title,
				URL:       p.HTMLURL,
				Author:    p.User.Login,
				Draft:     p.Draft,
				Labels:    labelNames(p.Labels),
				CreatedAt: p.CreatedAt,
				UpdatedAt: p.UpdatedAt,
				CI:        ci,
			})
		}
		if len(batch) < perPage {
			break
		}
	}
	return prs, nil
}

type issueJSON struct {
	Number      int             `json:"number"`
	Title       string          `json:"title"`
	HTMLURL     string          `json:"html_url"`
	User        userJSON        `json:"user"`
	Labels      []labelJSON     `json:"labels"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
	PullRequest json.RawMessage `json:"pull_request"`
}

// ListOpenIssues returns every open issue against repo — pull requests
// excluded, even though GitHub's issues endpoint returns both: an entry
// with a non-null pull_request field is a pull request wearing an issue
// number, not a real issue.
func (c *Client) ListOpenIssues(ctx context.Context, owner, name, repo string) ([]dashboard.Issue, error) {
	var issues []dashboard.Issue

	for page := 1; ; page++ {
		var batch []issueJSON
		q := url.Values{
			"state":    {"open"},
			"per_page": {strconv.Itoa(perPage)},
			"page":     {strconv.Itoa(page)},
		}
		path := fmt.Sprintf("/repos/%s/%s/issues", owner, name)
		if err := c.get(ctx, path, q, &batch); err != nil {
			return nil, err
		}
		for _, i := range batch {
			if i.PullRequest != nil {
				continue
			}
			issues = append(issues, dashboard.Issue{
				Forge:     dashboard.ForgeGitHub,
				Repo:      repo,
				Number:    i.Number,
				Title:     i.Title,
				URL:       i.HTMLURL,
				Author:    i.User.Login,
				Labels:    labelNames(i.Labels),
				CreatedAt: i.CreatedAt,
				UpdatedAt: i.UpdatedAt,
			})
		}
		if len(batch) < perPage {
			break
		}
	}
	return issues, nil
}

type checkRunJSON struct {
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
}

type checkRunsResponse struct {
	CheckRuns []checkRunJSON `json:"check_runs"`
}

type combinedStatusResponse struct {
	State string `json:"state"`
}

// ciStatus resolves the combined CI result for sha. GitHub Actions reports
// through the check-runs API; anything still using the older commit-status
// API (a third-party CI, a repo with no Actions workflow) only shows up on
// the combined-status endpoint, so that's the fallback when there are no
// check runs at all.
func (c *Client) ciStatus(ctx context.Context, owner, name, sha string) (dashboard.CIStatus, error) {
	if sha == "" {
		return dashboard.CINone, nil
	}

	var runs checkRunsResponse
	path := fmt.Sprintf("/repos/%s/%s/commits/%s/check-runs", owner, name, sha)
	if err := c.get(ctx, path, url.Values{"per_page": {strconv.Itoa(perPage)}}, &runs); err != nil {
		return dashboard.CINone, err
	}
	if len(runs.CheckRuns) > 0 {
		return statusFromCheckRuns(runs.CheckRuns), nil
	}

	var combined combinedStatusResponse
	path = fmt.Sprintf("/repos/%s/%s/commits/%s/status", owner, name, sha)
	if err := c.get(ctx, path, nil, &combined); err != nil {
		return dashboard.CINone, err
	}
	return statusFromCombinedState(combined.State), nil
}

func statusFromCheckRuns(runs []checkRunJSON) dashboard.CIStatus {
	failed := false
	for _, r := range runs {
		if r.Status != "completed" {
			return dashboard.CIPending
		}
		switch r.Conclusion {
		case "success", "neutral", "skipped":
			// counts as passing
		default:
			failed = true
		}
	}
	if failed {
		return dashboard.CIFailure
	}
	return dashboard.CISuccess
}

func statusFromCombinedState(state string) dashboard.CIStatus {
	switch state {
	case "success":
		return dashboard.CISuccess
	case "failure", "error":
		return dashboard.CIFailure
	case "pending":
		return dashboard.CIPending
	default:
		return dashboard.CINone
	}
}
