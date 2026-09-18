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
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
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
// The REST fallback is driven by google/go-github rather than hand-rolled
// requests — same wire calls, typed responses and typed rate-limit errors
// instead of reparsing JSON bodies by hand.
type Client struct {
	httpClient  *http.Client
	baseURL     string
	graphqlURL  string
	token       string
	username    string
	restClient  *ghsdk.Client
	webhookPath string
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

	httpClient := &http.Client{Timeout: 30 * time.Second}
	restClient := ghsdk.NewClient(httpClient)
	if token != "" {
		restClient = restClient.WithAuthToken(token)
	}
	if u, err := url.Parse(baseURL + "/"); err == nil {
		restClient.BaseURL = u
	}

	return &Client{
		httpClient: httpClient,
		baseURL:    baseURL,
		graphqlURL: baseURL + "/graphql",
		token:      token,
		username:   username,
		restClient: restClient,
	}
}

// Forge implements dashboard.Source.
func (c *Client) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

// SetWebhookPath tells Client the path (not the full URL — see
// dashboard.WebhookTargetsPath) this account's own GitHub webhook
// endpoint lives at, e.g. "/api/webhooks/github/<token>". Left unset,
// HasWebhook always reports false without calling GitHub at all — the
// same "optional, degrades quietly" shape RateLimit's nil pointer
// already uses elsewhere in this codebase.
func (c *Client) SetWebhookPath(path string) {
	c.webhookPath = path
}

// HasWebhook implements dashboard.WebhookChecker: does repo owner/name
// already have a webhook whose target URL is this account's own
// webhook endpoint. REST-only — GitHub's GraphQL schema doesn't expose
// webhook configuration — so this is one extra REST call per repo,
// outside GraphQL's own separate rate-limit budget.
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
// none does — shared by HasWebhook (always against c.webhookPath) and
// EnsureWebhook (against whatever path its own targetURL argument
// carries, independent of whether SetWebhookPath was ever called on
// this Client at all).
func (c *Client) findOwnHook(ctx context.Context, owner, name, wantPath string) (*ghsdk.Hook, error) {
	path := fmt.Sprintf("/repos/%s/%s/hooks", owner, name)
	opts := &ghsdk.ListOptions{PerPage: perPage}

	for {
		slog.Debug("github request", "method", http.MethodGet, "url", path)
		hooks, resp, err := c.restClient.Repositories.ListHooks(ctx, owner, name, opts)
		if err != nil {
			return nil, restError(http.MethodGet, path, err)
		}
		for _, h := range hooks {
			if h.Config != nil && dashboard.WebhookTargetsPath(h.Config.GetURL(), wantPath) {
				return h, nil
			}
		}
		if resp.NextPage == 0 {
			break
		}
		opts.Page = resp.NextPage
	}
	return nil, nil
}

// githubWebhookEvents mirrors what docs/webhooks.md's manual GitHub
// steps have a user tick by hand — Pull requests, Issues, Statuses,
// Check runs — so a webhook created here covers the same ground.
var githubWebhookEvents = []string{"pull_request", "issues", "status", "check_run"}

// EnsureWebhook implements dashboard.WebhookManager: create a webhook
// targeting targetURL if owner/name has none yet, or bring an existing
// one (found by matching targetURL's own path, not c.webhookPath — this
// method is self-contained even if SetWebhookPath was never called)
// back to active with the right config rather than creating a second,
// duplicate hook — GitHub, unlike Forgejo, allows several hooks with
// the identical URL, so nothing stops a duplicate except checking first.
func (c *Client) EnsureWebhook(ctx context.Context, owner, name, targetURL, secret string) error {
	u, err := url.Parse(targetURL)
	if err != nil {
		return fmt.Errorf("github: invalid webhook target URL: %w", err)
	}

	existing, err := c.findOwnHook(ctx, owner, name, u.Path)
	if err != nil {
		return asClientError(err)
	}

	contentType := "json"
	active := true
	hook := &ghsdk.Hook{
		Config: &ghsdk.HookConfig{
			URL:         &targetURL,
			ContentType: &contentType,
			Secret:      &secret,
		},
		Events: githubWebhookEvents,
		Active: &active,
	}

	if existing != nil {
		path := fmt.Sprintf("/repos/%s/%s/hooks/%d", owner, name, existing.GetID())
		slog.Debug("github request", "method", http.MethodPatch, "url", path)
		if _, _, err := c.restClient.Repositories.EditHook(ctx, owner, name, existing.GetID(), hook); err != nil {
			return asClientError(restError(http.MethodPatch, path, err))
		}
		return nil
	}

	path := fmt.Sprintf("/repos/%s/%s/hooks", owner, name)
	slog.Debug("github request", "method", http.MethodPost, "url", path)
	if _, _, err := c.restClient.Repositories.CreateHook(ctx, owner, name, hook); err != nil {
		return asClientError(restError(http.MethodPost, path, err))
	}
	return nil
}

// MergePullRequest implements dashboard.PullRequestMerger: merges
// owner/name#number, passing no PullRequestOptions so GitHub applies its
// own default merge method rather than this app picking one.
func (c *Client) MergePullRequest(ctx context.Context, owner, name string, number int) error {
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/merge", owner, name, number)
	slog.Debug("github request", "method", http.MethodPut, "url", path)
	if _, _, err := c.restClient.PullRequests.Merge(ctx, owner, name, number, "", nil); err != nil {
		return asClientError(restError(http.MethodPut, path, err))
	}
	return nil
}

// UpdateBranch implements dashboard.BranchUpdater: merges owner/name#number's
// base branch into its head branch. GitHub can schedule this as a
// background job and answer 202 before it's actually done — go-github
// surfaces that as a *github.AcceptedError rather than a real failure
// (see its own doc comment), so that specific case is unwrapped into
// accepted=true instead of being treated as an error.
func (c *Client) UpdateBranch(ctx context.Context, owner, name string, number int) (bool, error) {
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/update-branch", owner, name, number)
	slog.Debug("github request", "method", http.MethodPut, "url", path)
	_, _, err := c.restClient.PullRequests.UpdateBranch(ctx, owner, name, number, nil)
	if err != nil {
		var accepted *ghsdk.AcceptedError
		if errors.As(err, &accepted) {
			return true, nil
		}
		return false, asClientError(restError(http.MethodPut, path, err))
	}
	return false, nil
}

// CommentPullRequest implements dashboard.PullRequestCommenter: posts body
// as a plain comment on owner/name#number. GitHub has no separate
// pull-request-comment endpoint for a top-level comment — it's the same
// Issues API a regular issue comment uses, since every pull request is
// also an issue.
func (c *Client) CommentPullRequest(ctx context.Context, owner, name string, number int, body string) error {
	path := fmt.Sprintf("/repos/%s/%s/issues/%d/comments", owner, name, number)
	slog.Debug("github request", "method", http.MethodPost, "url", path)
	if _, _, err := c.restClient.Issues.CreateComment(ctx, owner, name, number, &ghsdk.IssueComment{Body: &body}); err != nil {
		return asClientError(restError(http.MethodPost, path, err))
	}
	return nil
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
	kind      dashboard.ForgeErrorKind
}

func (e *apiError) Error() string { return e.msg }

// asClientError promotes an *apiError to *dashboard.ClientError, the same
// boundary-crossing wrap internal/forgejo's client always applies
// (forgejoError) — apiError's own Kind is otherwise invisible to a caller
// outside this package, since dashboard.WebhookManager and the API
// handler that calls through it only know how to classify the exported
// type. err that isn't an *apiError (the url.Parse failure in
// EnsureWebhook, say) passes through unchanged.
func asClientError(err error) error {
	if err == nil {
		return nil
	}
	var apiErr *apiError
	if errors.As(err, &apiErr) {
		return &dashboard.ClientError{Kind: apiErr.kind, Err: err}
	}
	return err
}

// rateLimitShortMessage reports a short reason instead of GitHub's own
// message whenever the response's headers say rate limiting is the
// actual cause — the real body ("API rate limit exceeded for user ID
// 511318. If you reach out to GitHub Support for help, please include
// the request ID ... For more on scraping GitHub and how it may affect
// your rights, please review our Terms of Service...") is legal
// boilerplate meant for a developer reading API docs, not a line on a
// dashboard, and the actual budget is what the rate-limit chip (built
// from the RateLimit rateLimitFromHeaders reports alongside this)
// already shows right next to it. Checked purely from headers, not the
// response body or status code, because GitHub reports rate limiting
// both ways: a non-2xx status with this body shape, and — seen live —
// an HTTP 200 carrying the same complaint as a GraphQL-level error
// instead. ok is false for anything else (a bad token, a real outage),
// which keeps GitHub's own message — normally short and specific
// ("Bad credentials", "Not Found").
func rateLimitShortMessage(h http.Header) (msg string, ok bool) {
	if h.Get("X-RateLimit-Remaining") == "0" {
		return "rate limit exceeded", true
	}
	if retryAfter := h.Get("Retry-After"); retryAfter != "" {
		return fmt.Sprintf("rate limited, retry after %ss", retryAfter), true
	}
	return "", false
}

// forgeErrorKindFromStatus classifies an HTTP status code from a response
// GitHub actually sent back. Rate limiting is classified from headers
// first (rateLimitShortMessage) wherever that's checked before this, since
// GitHub doesn't always use 429 for it (403 with a zero remaining budget
// is the more common shape) — this is the fallback for the rest.
func forgeErrorKindFromStatus(statusCode int) dashboard.ForgeErrorKind {
	switch statusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return dashboard.ForgeErrorUnauthorized
	case http.StatusNotFound:
		return dashboard.ForgeErrorNotFound
	case http.StatusTooManyRequests:
		return dashboard.ForgeErrorRateLimited
	// MethodNotAllowed is what GitHub's own merge endpoint returns for a
	// PR that isn't currently mergeable; Conflict covers the sha-mismatch
	// case the same endpoint also uses.
	case http.StatusMethodNotAllowed, http.StatusConflict:
		return dashboard.ForgeErrorConflict
	default:
		return dashboard.ForgeErrorUnknown
	}
}

// graphqlErrorKind classifies a GraphQL query-level error (an HTTP 200
// with a populated "errors" array, so there's no status code to key off)
// by the extension type GitHub's own GraphQL errors carry. Not formally
// versioned API, so an unrecognized or absent type falls back to unknown
// rather than guessing.
func graphqlErrorKind(extensionType string) dashboard.ForgeErrorKind {
	switch extensionType {
	case "FORBIDDEN", "UNAUTHENTICATED", "INSUFFICIENT_SCOPES":
		return dashboard.ForgeErrorUnauthorized
	case "NOT_FOUND":
		return dashboard.ForgeErrorNotFound
	case "RATE_LIMITED":
		return dashboard.ForgeErrorRateLimited
	default:
		return dashboard.ForgeErrorUnknown
	}
}

// apiErrorDetail turns a failed response into the reason a person reading
// the dashboard's forge-health error actually needs — and the rate-limit
// budget the response reported, if any.
func apiErrorDetail(resp *http.Response) (string, *dashboard.RateLimit) {
	rl := rateLimitFromHeaders(resp.Header)

	if msg, ok := rateLimitShortMessage(resp.Header); ok {
		return msg, rl
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

// mergeStatusFromGraphQL maps GitHub's own mergeStateStatus — CLEAN is the
// only genuinely mergeable state; DIRTY is a real conflict; BLOCKED,
// BEHIND, UNSTABLE and HAS_HOOKS all mean something else is stopping the
// merge without asserting a conflict; DRAFT and UNKNOWN (GitHub hasn't
// finished computing it yet) both fall back to MergeUnknown rather than
// guessing. See design.md's Decisions in
// openspec/changes/archive/*/show-pr-merge-status for the mapping.
func mergeStatusFromGraphQL(state string) dashboard.MergeStatus {
	switch state {
	case "CLEAN":
		return dashboard.MergeMergeable
	case "DIRTY":
		return dashboard.MergeConflicting
	case "BLOCKED", "BEHIND", "UNSTABLE", "HAS_HOOKS":
		return dashboard.MergeBlocked
	default:
		return dashboard.MergeUnknown
	}
}

type graphqlAutoMergeRequest struct {
	MergeMethod string `json:"mergeMethod"`
}

type graphqlPullRequest struct {
	Number           int                      `json:"number"`
	Title            string                   `json:"title"`
	URL              string                   `json:"url"`
	IsDraft          bool                     `json:"isDraft"`
	Author           *graphqlActor            `json:"author"`
	MergeStateStatus string                   `json:"mergeStateStatus"`
	AutoMergeRequest *graphqlAutoMergeRequest `json:"autoMergeRequest"`
	Labels           struct {
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
	URL              string `json:"url"`
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

// canManageWebhooks mirrors GitHub's own requirement for its hooks
// endpoints: admin on the repo, not merely write access — anything less
// than ADMIN gets a 404 from GET .../hooks (see Client.HasWebhook's doc
// comment), which without this check reads as a broken "Add a webhook"
// button instead of a permission this app already knew about.
func canManageWebhooks(permission string) bool {
	return permission == "ADMIN"
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
        url
        isArchived
        isFork
        viewerPermission
        owner {
          login
        }
        pullRequests(states: OPEN, first: %[1]d, orderBy: {field: CREATED_AT, direction: DESC}) {
          nodes {
            number
            title
            url
            isDraft
            author {
              login
            }
            mergeStateStatus
            autoMergeRequest {
              mergeMethod
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
        issues(states: OPEN, first: %[1]d, orderBy: {field: CREATED_AT, direction: DESC}) {
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
	Message    string `json:"message"`
	Extensions struct {
		Type string `json:"type"`
	} `json:"extensions"`
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
		return &apiError{
			msg:  fmt.Sprintf("github: POST /graphql: %s", err),
			kind: dashboard.ForgeErrorUnreachable,
		}
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg, rl := apiErrorDetail(resp)
		kind := dashboard.ForgeErrorRateLimited
		if _, ok := rateLimitShortMessage(resp.Header); !ok {
			kind = forgeErrorKindFromStatus(resp.StatusCode)
		}
		return &apiError{msg: fmt.Sprintf("github: POST /graphql: %s", msg), rateLimit: rl, kind: kind}
	}

	var envelope struct {
		Data   json.RawMessage     `json:"data"`
		Errors []graphqlErrorEntry `json:"errors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return err
	}
	if len(envelope.Errors) > 0 {
		rl := rateLimitFromHeaders(resp.Header)
		msg := envelope.Errors[0].Message
		kind := graphqlErrorKind(envelope.Errors[0].Extensions.Type)
		// GitHub sometimes reports rate limiting as a query-level error in
		// a 200 response rather than rejecting the request outright — the
		// same headers are still there, so it gets the same short message
		// and the same RateLimit reporting as the HTTP-status failure path.
		if short, ok := rateLimitShortMessage(resp.Header); ok {
			msg = short
			kind = dashboard.ForgeErrorRateLimited
		}
		return &apiError{msg: fmt.Sprintf("github: graphql: %s", msg), rateLimit: rl, kind: kind}
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
			health := dashboard.ForgeHealth{
				Forge: dashboard.ForgeGitHub, Reachable: false,
				Error: err.Error(), ErrorKind: dashboard.ForgeErrorUnknown,
			}
			var apiErr *apiError
			if errors.As(err, &apiErr) {
				health.RateLimit = apiErr.rateLimit
				health.ErrorKind = apiErr.kind
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

	tracked := make([]graphqlRepo, 0, len(repos))
	for _, r := range repos {
		if r.IsArchived || r.IsFork || !hasWriteAccess(r.ViewerPermission) {
			continue
		}
		tracked = append(tracked, r)
	}
	hasWebhook := c.checkWebhooks(ctx, tracked)

	result := dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RateLimit: rateLimit, RepoCount: len(tracked)}}
	for _, r := range tracked {
		fullName := r.Owner.Login + "/" + r.Name
		result.Repos = append(result.Repos, dashboard.Repo{
			Forge:             dashboard.ForgeGitHub,
			FullName:          fullName,
			URL:               r.URL,
			HasWebhook:        hasWebhook[fullName],
			CanManageWebhooks: canManageWebhooks(r.ViewerPermission),
		})

		for _, p := range r.PullRequests.Nodes {
			result.PullRequests = append(result.PullRequests, mapPullRequest(fullName, p))
		}
		for _, i := range r.Issues.Nodes {
			result.Issues = append(result.Issues, mapIssue(fullName, i))
		}
	}
	return result
}

// checkWebhooks calls HasWebhook for every tracked repo concurrently,
// bounded the same way GenericSource.Fetch bounds its own per-repo
// calls — GraphQL already batched PRs/issues into the single query
// above, so this is the one place fetchViaGraphQL still makes a REST
// call per repo. Returns an empty map without calling GitHub at all
// when no webhook path is configured.
func (c *Client) checkWebhooks(ctx context.Context, repos []graphqlRepo) map[string]bool {
	result := make(map[string]bool, len(repos))
	if c.webhookPath == "" {
		return result
	}

	var mu sync.Mutex
	sem := make(chan struct{}, dashboard.DefaultMaxConcurrency)
	var wg sync.WaitGroup

	for _, r := range repos {
		wg.Add(1)
		go func(r graphqlRepo) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			fullName := r.Owner.Login + "/" + r.Name
			has, err := c.HasWebhook(ctx, r.Owner.Login, r.Name)
			if err != nil {
				slog.Warn("webhook check failed", "forge", dashboard.ForgeGitHub, "repo", fullName, "error", err)
				return
			}
			mu.Lock()
			result[fullName] = has
			mu.Unlock()
		}(r)
	}
	wg.Wait()
	return result
}

// boolPtr is a small local helper for filling dashboard.PullRequest's
// AutoMergeEnabled — a *bool because Forgejo has no way to report this at
// all (nil there), unlike GitHub, which always knows either way.
func boolPtr(b bool) *bool { return &b }

func mapPullRequest(fullName string, p graphqlPullRequest) dashboard.PullRequest {
	return dashboard.PullRequest{
		Forge:            dashboard.ForgeGitHub,
		Repo:             fullName,
		Number:           p.Number,
		Title:            p.Title,
		URL:              p.URL,
		Author:           authorLogin(p.Author),
		Draft:            p.IsDraft,
		Labels:           labelsFromNodes(p.Labels.Nodes),
		CreatedAt:        p.CreatedAt,
		UpdatedAt:        p.UpdatedAt,
		CI:               ciFromRollup(p.Commits.Nodes),
		MergeStatus:      mergeStatusFromGraphQL(p.MergeStateStatus),
		Behind:           p.MergeStateStatus == "BEHIND",
		AutoMergeEnabled: boolPtr(p.AutoMergeRequest != nil),
	}
}

func mapIssue(fullName string, i graphqlIssue) dashboard.Issue {
	return dashboard.Issue{
		Forge:     dashboard.ForgeGitHub,
		Repo:      fullName,
		Number:    i.Number,
		Title:     i.Title,
		URL:       i.URL,
		Author:    authorLogin(i.Author),
		Labels:    labelsFromNodes(i.Labels.Nodes),
		CreatedAt: i.CreatedAt,
		UpdatedAt: i.UpdatedAt,
	}
}

// repoQueryTemplate is reposQueryTemplate's single-repo counterpart —
// same pull request/issue field shapes, scoped to the one repository a
// webhook delivery already names, for RefreshRepo (dashboard.
// RepoRefresher) rather than a full account-wide Fetch.
const repoQueryTemplate = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: %[1]d, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        isDraft
        author {
          login
        }
        mergeStateStatus
        autoMergeRequest {
          mergeMethod
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
    issues(states: OPEN, first: %[1]d, orderBy: {field: CREATED_AT, direction: DESC}) {
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
`

var repoQuery = fmt.Sprintf(repoQueryTemplate, itemsPerRepo)

type repoQueryResponse struct {
	Repository *struct {
		PullRequests struct {
			Nodes []graphqlPullRequest `json:"nodes"`
		} `json:"pullRequests"`
		Issues struct {
			Nodes []graphqlIssue `json:"nodes"`
		} `json:"issues"`
	} `json:"repository"`
}

// FetchRepo implements dashboard.RepoRefresher: the single-repo
// counterpart to Fetch's account-wide GraphQL query, for a webhook
// delivery that already knows exactly which repo changed.
func (c *Client) FetchRepo(ctx context.Context, owner, name, fullName string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	var resp repoQueryResponse
	if err := c.graphqlDo(ctx, repoQuery, map[string]any{"owner": owner, "name": name}, &resp); err != nil {
		return nil, nil, err
	}
	if resp.Repository == nil {
		return nil, nil, fmt.Errorf("github: graphql: repository %s not found", fullName)
	}

	prs := make([]dashboard.PullRequest, 0, len(resp.Repository.PullRequests.Nodes))
	for _, p := range resp.Repository.PullRequests.Nodes {
		prs = append(prs, mapPullRequest(fullName, p))
	}
	issues := make([]dashboard.Issue, 0, len(resp.Repository.Issues.Nodes))
	for _, i := range resp.Repository.Issues.Nodes {
		issues = append(issues, mapIssue(fullName, i))
	}
	return prs, issues, nil
}

// ==== REST fallback (username only, no token) ====
//
// GitHub's GraphQL API allows no anonymous access at all, so the
// public-repos mode keeps using REST. It stays sequential rather than
// concurrent, unlike the old GenericSource-driven fetch: unauthenticated
// requests are IP-limited to 60/hour, a budget concurrency would only
// burn through faster.

// restError turns a failed go-github REST call into the reason a person
// reading the dashboard's forge-health error actually needs — go-github's
// typed RateLimitError/AbuseRateLimitError already carry the same
// legal-boilerplate body GitHub's REST API returns, so this shortens it
// the same way rateLimitShortMessage does for the GraphQL path, just
// against a typed error instead of raw response headers.
func restError(method, path string, err error) error {
	var rateLimitErr *ghsdk.RateLimitError
	if errors.As(err, &rateLimitErr) {
		return &apiError{
			msg:  fmt.Sprintf("github: %s %s: rate limit exceeded", method, path),
			kind: dashboard.ForgeErrorRateLimited,
		}
	}
	var abuseErr *ghsdk.AbuseRateLimitError
	if errors.As(err, &abuseErr) {
		return &apiError{
			msg:  fmt.Sprintf("github: %s %s: rate limited", method, path),
			kind: dashboard.ForgeErrorRateLimited,
		}
	}
	var errResp *ghsdk.ErrorResponse
	if errors.As(err, &errResp) {
		kind := dashboard.ForgeErrorUnknown
		if errResp.Response != nil {
			kind = forgeErrorKindFromStatus(errResp.Response.StatusCode)
		}
		return &apiError{
			msg:  fmt.Sprintf("github: %s %s: %s", method, path, errResp.Message),
			kind: kind,
		}
	}
	return &apiError{
		msg:  fmt.Sprintf("github: %s %s: %s", method, path, err),
		kind: dashboard.ForgeErrorUnreachable,
	}
}

func (c *Client) fetchPublicViaREST(ctx context.Context) dashboard.Result {
	repos, err := c.listPublicRepos(ctx)
	if err != nil {
		slog.Warn("forge unreachable", "forge", dashboard.ForgeGitHub, "error", err)
		health := dashboard.ForgeHealth{
			Forge: dashboard.ForgeGitHub, Reachable: false,
			Error: err.Error(), ErrorKind: dashboard.ForgeErrorUnknown,
		}
		var apiErr *apiError
		if errors.As(err, &apiErr) {
			health.ErrorKind = apiErr.kind
		}
		return dashboard.Result{Health: health}
	}

	result := dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: len(repos)}}
	for _, repo := range repos {
		owner, name, fullName := repo.GetOwner().GetLogin(), repo.GetName(), repo.GetFullName()
		// CanManageWebhooks stays false: an unauthenticated, username-only
		// listing has no credential to manage anything with.
		result.Repos = append(result.Repos, dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: fullName, URL: repo.GetHTMLURL()})
		prs, err := c.listOpenPullRequestsREST(ctx, owner, name, fullName)
		if err != nil {
			slog.Warn("list pull requests failed", "forge", dashboard.ForgeGitHub, "repo", fullName, "error", err)
		}
		issues, err := c.listOpenIssuesREST(ctx, owner, name, fullName)
		if err != nil {
			slog.Warn("list issues failed", "forge", dashboard.ForgeGitHub, "repo", fullName, "error", err)
		}
		result.PullRequests = append(result.PullRequests, prs...)
		result.Issues = append(result.Issues, issues...)
	}
	return result
}

// listPublicRepos returns every public repository username owns, with no
// authentication at all — the same list anyone gets landing on
// github.com/username?tab=repositories.
func (c *Client) listPublicRepos(ctx context.Context) ([]*ghsdk.Repository, error) {
	var repos []*ghsdk.Repository
	path := fmt.Sprintf("/users/%s/repos", c.username)
	opts := &ghsdk.RepositoryListByUserOptions{Type: "owner", ListOptions: ghsdk.ListOptions{PerPage: perPage}}

	for {
		slog.Debug("github request", "method", http.MethodGet, "url", path)
		batch, resp, err := c.restClient.Repositories.ListByUser(ctx, c.username, opts)
		if err != nil {
			return nil, restError(http.MethodGet, path, err)
		}
		for _, r := range batch {
			if r.GetArchived() || r.GetFork() {
				continue
			}
			repos = append(repos, r)
		}
		if resp.NextPage == 0 {
			break
		}
		opts.Page = resp.NextPage
	}
	return repos, nil
}

func restLabelsToDashboard(labels []*ghsdk.Label) []dashboard.Label {
	out := make([]dashboard.Label, 0, len(labels))
	for _, l := range labels {
		out = append(out, dashboard.Label{Name: l.GetName(), Color: l.GetColor()})
	}
	return out
}

// listOpenPullRequestsREST returns every open pull request against repo,
// with CI resolved via the same check-runs/combined-status fallback the
// GraphQL path gets for free from statusCheckRollup.
func (c *Client) listOpenPullRequestsREST(ctx context.Context, owner, name, repo string) ([]dashboard.PullRequest, error) {
	var prs []dashboard.PullRequest
	path := fmt.Sprintf("/repos/%s/%s/pulls", owner, name)
	opts := &ghsdk.PullRequestListOptions{State: "open", ListOptions: ghsdk.ListOptions{PerPage: perPage}}

	for {
		slog.Debug("github request", "method", http.MethodGet, "url", path)
		batch, resp, err := c.restClient.PullRequests.List(ctx, owner, name, opts)
		if err != nil {
			return nil, restError(http.MethodGet, path, err)
		}
		for _, p := range batch {
			ci, err := c.ciStatusREST(ctx, owner, name, p.GetHead().GetSHA())
			if err != nil {
				ci = dashboard.CINone
			}
			prs = append(prs, dashboard.PullRequest{
				Forge:     dashboard.ForgeGitHub,
				Repo:      repo,
				Number:    p.GetNumber(),
				Title:     p.GetTitle(),
				URL:       p.GetHTMLURL(),
				Author:    p.GetUser().GetLogin(),
				Draft:     p.GetDraft(),
				Labels:    restLabelsToDashboard(p.Labels),
				CreatedAt: p.GetCreatedAt().Time,
				UpdatedAt: p.GetUpdatedAt().Time,
				CI:        ci,
				// Mergeable/MergeableState aren't populated by this List
				// call at all (go-github's own doc comment on
				// PullRequest) — resolving them would mean a per-PR Get,
				// on top of the per-PR CI call this path already makes,
				// against the unauthenticated 60-requests/hour budget
				// this whole path exists because of. Left MergeUnknown
				// rather than paying that cost; see design.md's Open
				// Questions in openspec/changes/archive/*/
				// show-pr-merge-status. AutoMerge, unlike Mergeable, *is*
				// already on this response for free.
				MergeStatus:      dashboard.MergeUnknown,
				AutoMergeEnabled: boolPtr(p.GetAutoMerge() != nil),
			})
		}
		if resp.NextPage == 0 {
			break
		}
		opts.Page = resp.NextPage
	}
	return prs, nil
}

// listOpenIssuesREST returns every open issue against repo — pull
// requests excluded, even though GitHub's REST issues endpoint returns
// both: an entry with a non-nil PullRequestLinks is a pull request
// wearing an issue number, not a real issue.
func (c *Client) listOpenIssuesREST(ctx context.Context, owner, name, repo string) ([]dashboard.Issue, error) {
	var issues []dashboard.Issue
	path := fmt.Sprintf("/repos/%s/%s/issues", owner, name)
	opts := &ghsdk.IssueListByRepoOptions{State: "open", ListOptions: ghsdk.ListOptions{PerPage: perPage}}

	for {
		slog.Debug("github request", "method", http.MethodGet, "url", path)
		batch, resp, err := c.restClient.Issues.ListByRepo(ctx, owner, name, opts)
		if err != nil {
			return nil, restError(http.MethodGet, path, err)
		}
		for _, i := range batch {
			if i.PullRequestLinks != nil {
				continue
			}
			issues = append(issues, dashboard.Issue{
				Forge:     dashboard.ForgeGitHub,
				Repo:      repo,
				Number:    i.GetNumber(),
				Title:     i.GetTitle(),
				URL:       i.GetHTMLURL(),
				Author:    i.GetUser().GetLogin(),
				Labels:    restLabelsToDashboard(i.Labels),
				CreatedAt: i.GetCreatedAt().Time,
				UpdatedAt: i.GetUpdatedAt().Time,
			})
		}
		if resp.NextPage == 0 {
			break
		}
		opts.ListOptions.Page = resp.NextPage
	}
	return issues, nil
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

	checkRunsPath := fmt.Sprintf("/repos/%s/%s/commits/%s/check-runs", owner, name, sha)
	slog.Debug("github request", "method", http.MethodGet, "url", checkRunsPath)
	runs, _, err := c.restClient.Checks.ListCheckRunsForRef(ctx, owner, name, sha, &ghsdk.ListCheckRunsOptions{
		ListOptions: ghsdk.ListOptions{PerPage: perPage},
	})
	if err != nil {
		return dashboard.CINone, restError(http.MethodGet, checkRunsPath, err)
	}
	if len(runs.CheckRuns) > 0 {
		return statusFromCheckRuns(runs.CheckRuns), nil
	}

	statusPath := fmt.Sprintf("/repos/%s/%s/commits/%s/status", owner, name, sha)
	slog.Debug("github request", "method", http.MethodGet, "url", statusPath)
	combined, _, err := c.restClient.Repositories.GetCombinedStatus(ctx, owner, name, sha, nil)
	if err != nil {
		return dashboard.CINone, restError(http.MethodGet, statusPath, err)
	}
	return statusFromCombinedState(combined.GetState()), nil
}

func statusFromCheckRuns(runs []*ghsdk.CheckRun) dashboard.CIStatus {
	failed := false
	for _, r := range runs {
		if r.GetStatus() != "completed" {
			return dashboard.CIPending
		}
		switch r.GetConclusion() {
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
