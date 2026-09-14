// Package github is a client for the pieces of the GitHub API
// forge-dashboard needs: which repositories the credential can write to,
// their open pull requests and issues, and combined CI status per pull
// request. With a token, it talks to GitHub's GraphQL API — one request
// returns everything a REST-based Client used to need one call per
// repo/PR/CI-check for, and GraphQL draws from its own separate rate-limit
// pool rather than the REST budget every other tool on the account shares.
// GraphQL requires authentication for every request, so the
// username-only (public repos, no token) mode still uses REST — a
// fallback path that was never part of the authenticated budget anyway.
package github

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
	"strconv"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

const defaultBaseURL = "https://api.github.com"

// perPage is the page size used for the REST fallback's paginated list
// calls. 100 is GitHub's maximum.
const perPage = 100

// itemsPerRepo bounds how many open pull requests/issues/labels the
// GraphQL query fetches per repository in one page. Generous for a
// personal or small-team account; a repo with more open items than this
// undercounts rather than paginating a second, nested dimension — a
// tradeoff worth revisiting if it ever bites a real account.
const itemsPerRepo = 50

// Client talks to GitHub, either as an authenticated user (a token,
// GraphQL) or anonymously against one user's public repositories (a
// username, no token, REST — GraphQL allows no anonymous access at all).
type Client struct {
	httpClient *http.Client
	baseURL    string
	graphqlURL string
	token      string
	username   string
}

// NewClient returns a Client. With token set, Fetch queries GraphQL for
// every repo the token can push to, private included. With token empty
// and username set, Fetch falls back to unauthenticated REST and returns
// only username's public repos — there's no "write access" to filter by
// without a credential, so this mode returns everything public GitHub
// already shows anyone.
// baseURL defaults to the real GitHub API; tests override it to point at
// an httptest.Server.
func NewClient(token, username, baseURL string) *Client {
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		baseURL:    baseURL,
		graphqlURL: baseURL + "/graphql",
		token:      token,
		username:   username,
	}
}

// Fetch implements dashboard.Source directly — GitHub drives its own
// fetch strategy (GraphQL vs. the REST fallback) rather than going
// through dashboard.GenericSource's one-call-per-repo model, which is
// exactly the round-trip count this exists to avoid.
func (c *Client) Fetch(ctx context.Context) dashboard.Result {
	switch {
	case c.token != "":
		return c.fetchViaGraphQL(ctx)
	case c.username != "":
		return c.fetchPublicViaREST(ctx)
	default:
		return dashboard.Result{Health: dashboard.ForgeHealth{
			Forge: dashboard.ForgeGitHub, Reachable: false,
			Error: "github: neither a token nor a username is configured",
		}}
	}
}

// ---- shared error handling ----

// rateLimitFromHeaders reads the budget GitHub reports on every response,
// success or failure alike — most usefully on a failure, since that's
// the one time a person reading forge-health actually needs to see it.
// Returns nil where the headers aren't present at all (a non-rate-limit
// failure, or a host that doesn't send them).
func rateLimitFromHeaders(h http.Header) *dashboard.RateLimit {
	limit, err1 := strconv.Atoi(h.Get("X-RateLimit-Limit"))
	remaining, err2 := strconv.Atoi(h.Get("X-RateLimit-Remaining"))
	reset, err3 := strconv.ParseInt(h.Get("X-RateLimit-Reset"), 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return nil
	}
	return &dashboard.RateLimit{Limit: limit, Remaining: remaining, ResetsAt: time.Unix(reset, 0).UTC()}
}

// apiError wraps a failed request with the short reason apiErrorDetail
// already built, plus whatever rate-limit budget the response's headers
// carried — carried as a typed field, not folded into the message, so a
// caller can populate ForgeHealth.RateLimit even from a failed request
// without re-parsing the error string.
type apiError struct {
	msg       string
	rateLimit *dashboard.RateLimit
}

func (e *apiError) Error() string { return e.msg }

// apiErrorDetail turns a failed response into the reason a person reading
// the dashboard's forge-health error actually needs — and the rate-limit
// budget the response reported, if any.
//
// Rate limiting gets its own short message rather than GitHub's own: the
// real body ("API rate limit exceeded for user ID 511318. If you reach
// out to GitHub Support for help, please include the request ID ... For
// more on scraping GitHub and how it may affect your rights, please
// review our Terms of Service...") is legal boilerplate meant for a
// developer reading API docs, not a line on a dashboard — and the actual
// budget is what the rate-limit chip (built from the RateLimit this
// returns) already shows right next to it. Anything else — a bad token,
// a real outage — keeps GitHub's own message, which is normally short
// and specific ("Bad credentials", "Not Found").
func apiErrorDetail(resp *http.Response) (string, *dashboard.RateLimit) {
	rl := rateLimitFromHeaders(resp.Header)

	if resp.Header.Get("X-RateLimit-Remaining") == "0" {
		return "rate limit exceeded", rl
	}
	if retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {
		return fmt.Sprintf("rate limited, retry after %ss", retryAfter), rl
	}

	msg := resp.Status
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err == nil {
		var apiErr struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(body, &apiErr) == nil && apiErr.Message != "" {
			msg = apiErr.Message
		}
	}
	return msg, rl
}

// ==== GraphQL path (token) ====

type graphqlLabelNode struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

func labelsFromNodes(nodes []graphqlLabelNode) []dashboard.Label {
	out := make([]dashboard.Label, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, dashboard.Label{Name: n.Name, Color: n.Color})
	}
	return out
}

type graphqlActor struct {
	Login string `json:"login"`
}

// authorLogin reports "ghost" for a null author — GitHub's own name for a
// deleted account, the same label the REST API's web UI uses.
func authorLogin(a *graphqlActor) string {
	if a == nil {
		return "ghost"
	}
	return a.Login
}

type statusCheckRollup struct {
	State string `json:"state"`
}

type prCommitNode struct {
	Commit struct {
		StatusCheckRollup *statusCheckRollup `json:"statusCheckRollup"`
	} `json:"commit"`
}

// ciFromRollup maps GraphQL's own combined-status field — computed
// server-side across both Actions check-runs and any legacy commit
// status, the same fallback ciStatus used to do by hand against two REST
// endpoints.
func ciFromRollup(commits []prCommitNode) dashboard.CIStatus {
	if len(commits) == 0 || commits[0].Commit.StatusCheckRollup == nil {
		return dashboard.CINone
	}
	switch commits[0].Commit.StatusCheckRollup.State {
	case "SUCCESS":
		return dashboard.CISuccess
	case "ERROR", "FAILURE":
		return dashboard.CIFailure
	case "PENDING", "EXPECTED":
		return dashboard.CIPending
	default:
		return dashboard.CINone
	}
}

type graphqlPullRequest struct {
	Number  int           `json:"number"`
	Title   string        `json:"title"`
	URL     string        `json:"url"`
	IsDraft bool          `json:"isDraft"`
	Author  *graphqlActor `json:"author"`
	Labels  struct {
		Nodes []graphqlLabelNode `json:"nodes"`
	} `json:"labels"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Commits   struct {
		Nodes []prCommitNode `json:"nodes"`
	} `json:"commits"`
}

type graphqlIssue struct {
	Number int           `json:"number"`
	Title  string        `json:"title"`
	URL    string        `json:"url"`
	Author *graphqlActor `json:"author"`
	Labels struct {
		Nodes []graphqlLabelNode `json:"nodes"`
	} `json:"labels"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type graphqlRepo struct {
	Name             string `json:"name"`
	IsArchived       bool   `json:"isArchived"`
	IsFork           bool   `json:"isFork"`
	ViewerPermission string `json:"viewerPermission"`
	Owner            struct {
		Login string `json:"login"`
	} `json:"owner"`
	PullRequests struct {
		Nodes []graphqlPullRequest `json:"nodes"`
	} `json:"pullRequests"`
	Issues struct {
		Nodes []graphqlIssue `json:"nodes"`
	} `json:"issues"`
}

// hasWriteAccess mirrors the REST client's old permissions.push filter —
// GraphQL's viewerPermission is a coarser ADMIN/MAINTAIN/WRITE/TRIAGE/READ
// enum, and write access is anything at WRITE or above.
func hasWriteAccess(permission string) bool {
	switch permission {
	case "ADMIN", "MAINTAIN", "WRITE":
		return true
	default:
		return false
	}
}

type repoConnection struct {
	PageInfo struct {
		HasNextPage bool   `json:"hasNextPage"`
		EndCursor   string `json:"endCursor"`
	} `json:"pageInfo"`
	Nodes []graphqlRepo `json:"nodes"`
}

type reposQueryResponse struct {
	RateLimit *struct {
		Limit     int       `json:"limit"`
		Remaining int       `json:"remaining"`
		ResetAt   time.Time `json:"resetAt"`
	} `json:"rateLimit"`
	Viewer struct {
		Repositories repoConnection `json:"repositories"`
	} `json:"viewer"`
}

// reposQuery fetches everything one refresh needs in a single round trip
// per page: the token's own rate-limit budget, every repo it can push to
// (forks excluded server-side), and each repo's open pull requests
// (drafts, labels, and combined CI status via statusCheckRollup) and open
// issues. GraphQL cleanly separates issues from pull requests, unlike
// REST's single endpoint — no client-side "is this actually a PR"
// filtering needed.
const reposQueryTemplate = `
query($cursor: String) {
  rateLimit {
    limit
    remaining
    resetAt
  }
  viewer {
    repositories(first: 50, after: $cursor, affiliations: [OWNER, COLLABORATOR], isFork: false) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        name
        isArchived
        isFork
        viewerPermission
        owner {
          login
        }
        pullRequests(states: OPEN, first: %[1]d) {
          nodes {
            number
            title
            url
            isDraft
            author {
              login
            }
            labels(first: 20) {
              nodes {
                name
                color
              }
            }
            createdAt
            updatedAt
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup {
                    state
                  }
                }
              }
            }
          }
        }
        issues(states: OPEN, first: %[1]d) {
          nodes {
            number
            title
            url
            author {
              login
            }
            labels(first: 20) {
              nodes {
                name
                color
              }
            }
            createdAt
            updatedAt
          }
        }
      }
    }
  }
}
`

var reposQuery = fmt.Sprintf(reposQueryTemplate, itemsPerRepo)

type graphqlRequestBody struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables,omitempty"`
}

type graphqlErrorEntry struct {
	Message string `json:"message"`
}

// graphqlDo posts one GraphQL request and decodes its data into out.
// GitHub reports a request rejected before execution (bad auth, rate
// limiting) as a non-2xx status with the same error body REST uses; a
// query-level failure comes back as 200 with a populated "errors" array
// instead.
func (c *Client) graphqlDo(ctx context.Context, query string, variables map[string]any, out any) error {
	body, err := json.Marshal(graphqlRequestBody{Query: query, Variables: variables})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.graphqlURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)

	slog.Debug("github request", "method", http.MethodPost, "url", c.graphqlURL, "cursor", variables["cursor"])
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg, rl := apiErrorDetail(resp)
		return &apiError{msg: fmt.Sprintf("github: POST /graphql: %s", msg), rateLimit: rl}
	}

	var envelope struct {
		Data   json.RawMessage     `json:"data"`
		Errors []graphqlErrorEntry `json:"errors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return err
	}
	if len(envelope.Errors) > 0 {
		return fmt.Errorf("github: graphql: %s", envelope.Errors[0].Message)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(envelope.Data, out)
}

func (c *Client) fetchViaGraphQL(ctx context.Context) dashboard.Result {
	var repos []graphqlRepo
	var rateLimit *dashboard.RateLimit
	var cursor *string

	for {
		var resp reposQueryResponse
		if err := c.graphqlDo(ctx, reposQuery, map[string]any{"cursor": cursor}, &resp); err != nil {
			slog.Warn("forge unreachable", "forge", dashboard.ForgeGitHub, "error", err)
			health := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: false, Error: err.Error()}
			var apiErr *apiError
			if errors.As(err, &apiErr) {
				health.RateLimit = apiErr.rateLimit
			}
			return dashboard.Result{Health: health}
		}
		if resp.RateLimit != nil {
			rateLimit = &dashboard.RateLimit{
				Limit:     resp.RateLimit.Limit,
				Remaining: resp.RateLimit.Remaining,
				ResetsAt:  resp.RateLimit.ResetAt,
			}
		}
		repos = append(repos, resp.Viewer.Repositories.Nodes...)
		if !resp.Viewer.Repositories.PageInfo.HasNextPage {
			break
		}
		endCursor := resp.Viewer.Repositories.PageInfo.EndCursor
		cursor = &endCursor
	}

	result := dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RateLimit: rateLimit}}
	for _, r := range repos {
		if r.IsArchived || r.IsFork || !hasWriteAccess(r.ViewerPermission) {
			continue
		}
		result.Health.RepoCount++
		fullName := r.Owner.Login + "/" + r.Name

		for _, p := range r.PullRequests.Nodes {
			result.PullRequests = append(result.PullRequests, dashboard.PullRequest{
				Forge:     dashboard.ForgeGitHub,
				Repo:      fullName,
				Number:    p.Number,
				Title:     p.Title,
				URL:       p.URL,
				Author:    authorLogin(p.Author),
				Draft:     p.IsDraft,
				Labels:    labelsFromNodes(p.Labels.Nodes),
				CreatedAt: p.CreatedAt,
				UpdatedAt: p.UpdatedAt,
				CI:        ciFromRollup(p.Commits.Nodes),
			})
		}
		for _, i := range r.Issues.Nodes {
			result.Issues = append(result.Issues, dashboard.Issue{
				Forge:     dashboard.ForgeGitHub,
				Repo:      fullName,
				Number:    i.Number,
				Title:     i.Title,
				URL:       i.URL,
				Author:    authorLogin(i.Author),
				Labels:    labelsFromNodes(i.Labels.Nodes),
				CreatedAt: i.CreatedAt,
				UpdatedAt: i.UpdatedAt,
			})
		}
	}
	return result
}

// ==== REST fallback (username only, no token) ====
//
// GitHub's GraphQL API allows no anonymous access at all, so the
// public-repos mode keeps using REST. It stays sequential rather than
// concurrent, unlike the old GenericSource-driven fetch: unauthenticated
// requests are IP-limited to 60/hour, a budget concurrency would only
// burn through faster.

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

	slog.Debug("github request", "method", http.MethodGet, "url", u)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// The REST fallback (unauthenticated, public-repos mode) has no
		// rate-limit reporting of its own — its 60/hour budget is IP-scoped,
		// not worth surfacing the same way a real credential's is.
		msg, _ := apiErrorDetail(resp)
		return fmt.Errorf("github: GET %s: %s", path, msg)
	}

	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

type restRepo struct {
	FullName string `json:"full_name"`
	Name     string `json:"name"`
	Owner    struct {
		Login string `json:"login"`
	} `json:"owner"`
	Archived bool `json:"archived"`
	Fork     bool `json:"fork"`
}

type restUser struct {
	Login string `json:"login"`
}

type restLabel struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

func (c *Client) fetchPublicViaREST(ctx context.Context) dashboard.Result {
	repos, err := c.listPublicRepos(ctx)
	if err != nil {
		slog.Warn("forge unreachable", "forge", dashboard.ForgeGitHub, "error", err)
		return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: false, Error: err.Error()}}
	}

	result := dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: len(repos)}}
	for _, repo := range repos {
		prs, err := c.listOpenPullRequestsREST(ctx, repo.Owner.Login, repo.Name, repo.FullName)
		if err != nil {
			slog.Warn("list pull requests failed", "forge", dashboard.ForgeGitHub, "repo", repo.FullName, "error", err)
		}
		issues, err := c.listOpenIssuesREST(ctx, repo.Owner.Login, repo.Name, repo.FullName)
		if err != nil {
			slog.Warn("list issues failed", "forge", dashboard.ForgeGitHub, "repo", repo.FullName, "error", err)
		}
		result.PullRequests = append(result.PullRequests, prs...)
		result.Issues = append(result.Issues, issues...)
	}
	return result
}

// listPublicRepos returns every public repository username owns, with no
// authentication at all — the same list anyone gets landing on
// github.com/username?tab=repositories.
func (c *Client) listPublicRepos(ctx context.Context) ([]restRepo, error) {
	var repos []restRepo

	for page := 1; ; page++ {
		var batch []restRepo
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
			if r.Archived || r.Fork {
				continue
			}
			repos = append(repos, r)
		}
		if len(batch) < perPage {
			break
		}
	}
	return repos, nil
}

type restPull struct {
	Number    int         `json:"number"`
	Title     string      `json:"title"`
	HTMLURL   string      `json:"html_url"`
	Draft     bool        `json:"draft"`
	User      restUser    `json:"user"`
	Labels    []restLabel `json:"labels"`
	CreatedAt time.Time   `json:"created_at"`
	UpdatedAt time.Time   `json:"updated_at"`
	Head      struct {
		SHA string `json:"sha"`
	} `json:"head"`
}

func restLabelsToDashboard(labels []restLabel) []dashboard.Label {
	out := make([]dashboard.Label, 0, len(labels))
	for _, l := range labels {
		out = append(out, dashboard.Label{Name: l.Name, Color: l.Color})
	}
	return out
}

// listOpenPullRequestsREST returns every open pull request against repo,
// with CI resolved via the same check-runs/combined-status fallback the
// GraphQL path gets for free from statusCheckRollup.
func (c *Client) listOpenPullRequestsREST(ctx context.Context, owner, name, repo string) ([]dashboard.PullRequest, error) {
	var prs []dashboard.PullRequest

	for page := 1; ; page++ {
		var batch []restPull
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
			ci, err := c.ciStatusREST(ctx, owner, name, p.Head.SHA)
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
				Labels:    restLabelsToDashboard(p.Labels),
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

type restIssue struct {
	Number      int             `json:"number"`
	Title       string          `json:"title"`
	HTMLURL     string          `json:"html_url"`
	User        restUser        `json:"user"`
	Labels      []restLabel     `json:"labels"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
	PullRequest json.RawMessage `json:"pull_request"`
}

// listOpenIssuesREST returns every open issue against repo — pull
// requests excluded, even though GitHub's REST issues endpoint returns
// both: an entry with a non-null pull_request field is a pull request
// wearing an issue number, not a real issue.
func (c *Client) listOpenIssuesREST(ctx context.Context, owner, name, repo string) ([]dashboard.Issue, error) {
	var issues []dashboard.Issue

	for page := 1; ; page++ {
		var batch []restIssue
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
				Labels:    restLabelsToDashboard(i.Labels),
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

type restCheckRun struct {
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
}

type restCheckRunsResponse struct {
	CheckRuns []restCheckRun `json:"check_runs"`
}

type restCombinedStatusResponse struct {
	State string `json:"state"`
}

// ciStatusREST resolves the combined CI result for sha. GitHub Actions
// reports through the check-runs API; anything still using the older
// commit-status API (a third-party CI, a repo with no Actions workflow)
// only shows up on the combined-status endpoint, so that's the fallback
// when there are no check runs at all.
func (c *Client) ciStatusREST(ctx context.Context, owner, name, sha string) (dashboard.CIStatus, error) {
	if sha == "" {
		return dashboard.CINone, nil
	}

	var runs restCheckRunsResponse
	path := fmt.Sprintf("/repos/%s/%s/commits/%s/check-runs", owner, name, sha)
	if err := c.get(ctx, path, url.Values{"per_page": {strconv.Itoa(perPage)}}, &runs); err != nil {
		return dashboard.CINone, err
	}
	if len(runs.CheckRuns) > 0 {
		return statusFromCheckRuns(runs.CheckRuns), nil
	}

	var combined restCombinedStatusResponse
	path = fmt.Sprintf("/repos/%s/%s/commits/%s/status", owner, name, sha)
	if err := c.get(ctx, path, nil, &combined); err != nil {
		return dashboard.CINone, err
	}
	return statusFromCombinedState(combined.State), nil
}

func statusFromCheckRuns(runs []restCheckRun) dashboard.CIStatus {
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
