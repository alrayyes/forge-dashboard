package dashboard

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
)

// errUnsupportedByClient is what a GenericSource answers when its forge's
// client lacks an optional capability the caller asked for.
var errUnsupportedByClient = errors.New("not supported by this client")

// errRepoNotListed is why a scoped default-branch read had no repo to read: no
// full poll has listed it yet (#1316).
var errRepoNotListed = errors.New("not listed by a full poll yet")

// DefaultMaxConcurrency bounds how many repositories a GenericSource fetches
// at once. Generous enough to make quick work of a ~100-repo account
// without opening that many sockets at once for no benefit.
const DefaultMaxConcurrency = 8

// RepoRef names one repository a ForgeClient is configured to track —
// every repo the configured credential has write access to, or, with no
// credential at all, every public repo a configured username owns.
type RepoRef struct {
	FullName string
	Owner    string
	Name     string
	// URL is the repo's own page on its forge — see Repo.URL.
	URL string
	// CanManageWebhooks — see Repo.CanManageWebhooks.
	CanManageWebhooks bool
	// DefaultBranch is the repo's default branch, "" when the forge says none.
	DefaultBranch string
}

// ForgeClient is what a forge-specific client (internal/github,
// internal/forgejo) provides for GenericSource to drive. Both clients'
// method sets already match this shape, so neither needs an adapter.
type ForgeClient interface {
	ListRepos(ctx context.Context) ([]RepoRef, error)
	ListOpenPullRequests(ctx context.Context, owner, name, repo string) ([]PullRequest, error)
	ListOpenIssues(ctx context.Context, owner, name, repo string) ([]Issue, error)
}

// RateLimiter is implemented by a ForgeClient that can report its own API
// rate-limit status — GitHub can; Forgejo can't, since it has no rate
// limiting of its own by default. GenericSource checks for this via a
// type assertion rather than adding it to ForgeClient itself, so a client
// with nothing to report doesn't need a no-op method.
type RateLimiter interface {
	RateLimit(ctx context.Context) (RateLimit, error)
}

// GenericSource drives a ForgeClient the same way regardless of which forge
// it talks to: list repositories, then fetch each one's open pull requests
// and issues concurrently, bounded, skipping a single repo's failure rather
// than failing the whole forge.
type GenericSource struct {
	forge          Forge
	client         ForgeClient
	maxConcurrency int

	// refs is each repo the last full poll listed, by full name, so a scoped
	// default-branch read (#1316) needs no ListRepos call to learn the
	// repo's default branch and URL.
	refsMu sync.Mutex
	refs   map[string]RepoRef
}

// NewGenericSource returns a Source reporting as forge, driving client with
// at most maxConcurrency repositories fetched at once.
func NewGenericSource(forge Forge, client ForgeClient, maxConcurrency int) *GenericSource {
	return &GenericSource{forge: forge, client: client, maxConcurrency: maxConcurrency}
}

// Forge implements Source.
func (s *GenericSource) Forge() Forge { return s.forge }

// Fetch implements Source by listing repos, then fetching each one's open
// pull requests and issues concurrently, bounded by maxConcurrency. A
// single repo's failure is logged and skipped, not fatal to the forge.
func (s *GenericSource) Fetch(ctx context.Context) Result {
	repos, err := s.client.ListRepos(ctx)
	if err != nil {
		return s.unreachable(err)
	}

	s.rememberRepos(repos)
	results := s.fetchRepos(ctx, repos)

	result := Result{Health: ForgeHealth{Forge: s.forge, Reachable: true, RepoCount: len(repos)}}
	for i, repo := range repos {
		result.Repos = append(result.Repos, Repo{
			Forge:             s.forge,
			FullName:          repo.FullName,
			URL:               repo.URL,
			HasWebhook:        results[i].hasWebhook,
			CanManageWebhooks: repo.CanManageWebhooks,
		})
	}
	if rl, ok := s.client.(RateLimiter); ok {
		limit, err := rl.RateLimit(ctx)
		if err != nil {
			slog.Warn("rate limit check failed", "forge", s.forge, "error", err)
		} else {
			// Every ForgeClient GenericSource drives makes plain REST-style
			// per-repo calls (ListOpenPullRequests/ListOpenIssues/
			// HasWebhook) — no GraphQL involved at all, unlike GitHub's own
			// dedicated Fetch — so a budget reported here is always REST.
			result.Health.RateLimitREST = &limit
		}
	}
	for i, r := range results {
		result.PullRequests = append(result.PullRequests, r.prs...)
		result.Issues = append(result.Issues, r.issues...)
		if r.branch != nil {
			branch := *r.branch
			branch.Forge, branch.FullName, branch.URL = s.forge, repos[i].FullName, repos[i].URL
			if branch.FailingJobs == nil {
				branch.FailingJobs = []string{}
			}
			result.MainBranches = append(result.MainBranches, branch)
		}
		if r.prsFailed || r.issuesFailed || r.branchFailed {
			result.FailedRepos = append(result.FailedRepos, FailedRepo{
				FullName: repos[i].FullName, PullRequests: r.prsFailed, Issues: r.issuesFailed, MainBranch: r.branchFailed,
			})
		}
	}

	return result
}

// unreachable is the Result for a forge whose repo list couldn't be fetched.
func (s *GenericSource) unreachable(err error) Result {
	slog.Warn("forge unreachable", "forge", s.forge, "error", err)
	kind := ForgeErrorUnknown
	if clientErr, ok := errors.AsType[*ClientError](err); ok {
		kind = clientErr.Kind
	}
	// err's own text never reaches the client (#360) — logged above
	// for whoever operates this instance, but ForgeHealth.Error
	// carries HumanizeForgeError's mapped sentence instead, the same
	// "small, explicit mapping over a raw passthrough" app.js's own
	// ERROR_HEADLINES already uses for the headline shown alongside
	// this.
	health := ForgeHealth{Forge: s.forge, Reachable: false, Error: HumanizeForgeError(kind), ErrorKind: kind}

	return Result{Health: health}
}

// repoResult is what one repo's fetch brought back.
type repoResult struct {
	prs        []PullRequest
	issues     []Issue
	hasWebhook bool
	// prsFailed and issuesFailed mean the list is missing, not empty.
	prsFailed    bool
	issuesFailed bool
	// branch is the default branch's CI, nil when the client can't read it or
	// the read failed (branchFailed).
	branch       *MainBranch
	branchFailed bool
}

// fetchRepos fetches every repo, at most maxConcurrency at a time, and answers
// in the order of repos.
func (s *GenericSource) fetchRepos(ctx context.Context, repos []RepoRef) []repoResult {
	results := make([]repoResult, len(repos))
	sem := make(chan struct{}, s.maxConcurrency)
	var wg sync.WaitGroup

	for i, repo := range repos {
		wg.Add(1)
		go func(i int, repo RepoRef) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			results[i] = s.fetchRepo(ctx, repo)
		}(i, repo)
	}
	wg.Wait()

	return results
}

// fetchRepo fetches one repo's open pull requests and issues and, if the
// client can say, whether it has a webhook. Each failure is logged and leaves
// that part empty, flagged as failed so the empty list isn't read as an answer.
func (s *GenericSource) fetchRepo(ctx context.Context, repo RepoRef) repoResult {
	prs, err := s.client.ListOpenPullRequests(ctx, repo.Owner, repo.Name, repo.FullName)
	if err != nil {
		slog.Warn("list pull requests failed", "forge", s.forge, "repo", repo.FullName, "error", err)
	}
	prsFailed := err != nil
	issues, err := s.client.ListOpenIssues(ctx, repo.Owner, repo.Name, repo.FullName)
	if err != nil {
		slog.Warn("list issues failed", "forge", s.forge, "repo", repo.FullName, "error", err)
	}
	issuesFailed := err != nil
	var hasWebhook bool
	if checker, ok := s.client.(WebhookChecker); ok {
		hasWebhook, err = checker.HasWebhook(ctx, repo.Owner, repo.Name)
		if err != nil {
			slog.Warn("webhook check failed", "forge", s.forge, "repo", repo.FullName, "error", err)
		}
	}

	res := repoResult{prs: prs, issues: issues, hasWebhook: hasWebhook, prsFailed: prsFailed, issuesFailed: issuesFailed}
	if reader, ok := s.client.(MainBranchReader); ok {
		branch, err := reader.ReadMainBranch(ctx, repo)
		if err != nil {
			slog.Warn("read default branch failed", "forge", s.forge, "repo", repo.FullName, "error", err)
			res.branchFailed = true
		} else {
			res.branch = &branch
		}
	}

	return res
}

// EnsureWebhook implements WebhookManager at the Source level by
// delegating to the underlying client — the same "Source unwraps to its
// ForgeClient" pattern FetchRepo doesn't need, since ForgeClient's own
// method set already matches what RepoRefresher wants, but which
// WebhookManager does need since EnsureWebhook isn't part of the plain
// ForgeClient interface every client implements.
func (s *GenericSource) EnsureWebhook(ctx context.Context, owner, name, targetURL, secret string) error {
	manager, ok := s.client.(WebhookManager)
	if !ok {
		return fmt.Errorf("dashboard: %s's client can't manage webhooks: %w", s.forge, errUnsupportedByClient)
	}
	if err := manager.EnsureWebhook(ctx, owner, name, targetURL, secret); err != nil {
		return fmt.Errorf("dashboard: ensure webhook: %w", err)
	}

	return nil
}

// UpgradeWebhook implements WebhookUpgrader at the Source level by delegating
// to the underlying client, the same shape EnsureWebhook uses.
func (s *GenericSource) UpgradeWebhook(ctx context.Context, owner, name, targetURL, secret string) (bool, error) {
	upgrader, ok := s.client.(WebhookUpgrader)
	if !ok {
		return false, fmt.Errorf("dashboard: %s's client can't upgrade webhooks: %w", s.forge, errUnsupportedByClient)
	}
	updated, err := upgrader.UpgradeWebhook(ctx, owner, name, targetURL, secret)
	if err != nil {
		return false, fmt.Errorf("dashboard: upgrade webhook: %w", err)
	}

	return updated, nil
}

// MergePullRequest implements PullRequestMerger at the Source level by
// delegating to the underlying client, the same "Source unwraps to its
// ForgeClient" shape EnsureWebhook already uses.
func (s *GenericSource) MergePullRequest(ctx context.Context, owner, name string, number int) error {
	merger, ok := s.client.(PullRequestMerger)
	if !ok {
		return fmt.Errorf("dashboard: %s's client can't merge pull requests: %w", s.forge, errUnsupportedByClient)
	}
	if err := merger.MergePullRequest(ctx, owner, name, number); err != nil {
		return fmt.Errorf("dashboard: merge pull request: %w", err)
	}

	return nil
}

// ReadPullRequestState implements PullRequestStateReader at the Source
// level by delegating to the underlying client, the same shape
// MergePullRequest uses. The client's own error is returned as is, so its
// ClientError classification survives.
func (s *GenericSource) ReadPullRequestState(ctx context.Context, owner, name string, number int) (PullRequestState, error) {
	reader, ok := s.client.(PullRequestStateReader)
	if !ok {
		return PullRequestState{}, fmt.Errorf("dashboard: %s's client can't read pull request state: %w", s.forge, errUnsupportedByClient)
	}

	state, err := reader.ReadPullRequestState(ctx, owner, name, number)
	if err != nil {
		return state, fmt.Errorf("dashboard: read pull request state: %w", err)
	}

	return state, nil
}

// UpdateBranch implements BranchUpdater at the Source level by delegating
// to the underlying client, the same "Source unwraps to its ForgeClient"
// shape EnsureWebhook/MergePullRequest already use.
func (s *GenericSource) UpdateBranch(ctx context.Context, owner, name string, number int) (bool, error) {
	updater, ok := s.client.(BranchUpdater)
	if !ok {
		return false, fmt.Errorf("dashboard: %s's client can't update pull request branches: %w", s.forge, errUnsupportedByClient)
	}
	accepted, err := updater.UpdateBranch(ctx, owner, name, number)
	if err != nil {
		return accepted, fmt.Errorf("dashboard: update branch: %w", err)
	}

	return accepted, nil
}

// ClosePullRequest implements PullRequestCloser at the Source level by
// delegating to the underlying client, the same "Source unwraps to its
// ForgeClient" shape EnsureWebhook/MergePullRequest/UpdateBranch already
// use. Same #455 shape: internal/forgejo.Client already implements
// PullRequestCloser, but GenericSource (what BuildSources actually
// registers for Forgejo) never exposed it, so the type assertion in
// handlePullRequestClose always failed for a real Forgejo pull request
// (confirmed live: closing a real tracked pull request answered "forgejo
// doesn't support closing pull requests" even though the underlying
// client genuinely can).
func (s *GenericSource) ClosePullRequest(ctx context.Context, owner, name string, number int) error {
	closer, ok := s.client.(PullRequestCloser)
	if !ok {
		return fmt.Errorf("dashboard: %s's client can't close pull requests: %w", s.forge, errUnsupportedByClient)
	}
	if err := closer.ClosePullRequest(ctx, owner, name, number); err != nil {
		return fmt.Errorf("dashboard: close pull request: %w", err)
	}

	return nil
}

// ListChecks implements PullRequestChecker at the Source level by
// delegating to the underlying client, the same "Source unwraps to its
// ForgeClient" shape EnsureWebhook/MergePullRequest/UpdateBranch already
// use. #455: this forwarding was missing entirely — internal/forgejo.Client
// already implements PullRequestChecker, but GenericSource (what
// BuildSources actually registers for Forgejo) never exposed it, so the
// type assertion in handlePullRequestChecks always failed for a real
// Forgejo pull request.
func (s *GenericSource) ListChecks(ctx context.Context, owner, name string, number int) ([]Check, error) {
	checker, ok := s.client.(PullRequestChecker)
	if !ok {
		return nil, fmt.Errorf("dashboard: %s's client can't list pull request checks: %w", s.forge, errUnsupportedByClient)
	}
	checks, err := checker.ListChecks(ctx, owner, name, number)
	if err != nil {
		return nil, fmt.Errorf("dashboard: list checks: %w", err)
	}

	return checks, nil
}

// AddLabel implements PullRequestLabeler at the Source level by delegating to
// the underlying client, the same "Source unwraps to its ForgeClient" shape
// ClosePullRequest and ListChecks use. #1347: internal/forgejo.Client labels a
// pull request, but this was never forwarded, so Renovate: Rebase answered
// "forgejo doesn't support labeling pull requests" on every Forgejo pull
// request.
func (s *GenericSource) AddLabel(ctx context.Context, owner, name string, number int, label string) error {
	labeler, ok := s.client.(PullRequestLabeler)
	if !ok {
		return fmt.Errorf("dashboard: %s's client can't label pull requests: %w", s.forge, errUnsupportedByClient)
	}

	// Not wrapped: the handler shows the forge's own sentence for a refusal,
	// and a "dashboard:" prefix is what makes it fall back to the generic one.
	return labeler.AddLabel(ctx, owner, name, number, label) //nolint:wrapcheck // see above
}

// PullRequestBody implements PullRequestBodyEditor at the Source level, the
// same shape as AddLabel. Renovate's rebase checkbox lives in the body, so
// without this the checkbox path was never taken on Forgejo either (#1347).
func (s *GenericSource) PullRequestBody(ctx context.Context, owner, name string, number int) (string, error) {
	editor, ok := s.client.(PullRequestBodyEditor)
	if !ok {
		return "", fmt.Errorf("dashboard: %s's client can't read pull request descriptions: %w", s.forge, errUnsupportedByClient)
	}

	// Not wrapped, for the same reason as AddLabel.
	return editor.PullRequestBody(ctx, owner, name, number) //nolint:wrapcheck // see above
}

// SetPullRequestBody implements the other half of PullRequestBodyEditor.
func (s *GenericSource) SetPullRequestBody(ctx context.Context, owner, name string, number int, body string) error {
	editor, ok := s.client.(PullRequestBodyEditor)
	if !ok {
		return fmt.Errorf("dashboard: %s's client can't edit pull request descriptions: %w", s.forge, errUnsupportedByClient)
	}

	return editor.SetPullRequestBody(ctx, owner, name, number, body) //nolint:wrapcheck // as AddLabel
}

// GetPullRequestDetails implements PullRequestDetailer at the Source level, the
// same shape as ListChecks (#1506).
func (s *GenericSource) GetPullRequestDetails(ctx context.Context, owner, name string, number int) (PullRequestDetails, error) {
	detailer, ok := s.client.(PullRequestDetailer)
	if !ok {
		return PullRequestDetails{}, fmt.Errorf("dashboard: %s's client can't read pull request details: %w", s.forge, errUnsupportedByClient)
	}

	// Not wrapped, for the same reason as AddLabel.
	return detailer.GetPullRequestDetails(ctx, owner, name, number) //nolint:wrapcheck // see above
}

// RerunFailedChecks implements ChecksRerunner at the Source level, the same
// shape as AddLabel. internal/forgejo.Client reruns, but this was never
// forwarded, so Rerun failed checks answered 400 on every Forgejo pull request
// (#1351).
func (s *GenericSource) RerunFailedChecks(ctx context.Context, owner, name string, number int) error {
	rerunner, ok := s.client.(ChecksRerunner)
	if !ok {
		return fmt.Errorf("dashboard: %s's client can't rerun checks: %w", s.forge, errUnsupportedByClient)
	}

	// Not wrapped, for the same reason as AddLabel: the forge's own sentence
	// and its ClientError kind (409 for "no failed job") both have to survive.
	return rerunner.RerunFailedChecks(ctx, owner, name, number) //nolint:wrapcheck // see above
}

// FetchRepo implements RepoRefresher: the same per-repo calls Fetch
// already makes for every tracked repo, but for just the one a caller
// (a webhook delivery) already knows the identity of — no ListRepos
// call needed first.
func (s *GenericSource) FetchRepo(ctx context.Context, owner, name, fullName string) ([]PullRequest, []Issue, error) {
	prs, err := s.client.ListOpenPullRequests(ctx, owner, name, fullName)
	if err != nil {
		return nil, nil, fmt.Errorf("dashboard: list open pull requests: %w", err)
	}
	issues, err := s.client.ListOpenIssues(ctx, owner, name, fullName)
	if err != nil {
		return nil, nil, fmt.Errorf("dashboard: list open issues: %w", err)
	}

	return prs, issues, nil
}

func (s *GenericSource) rememberRepos(repos []RepoRef) {
	s.refsMu.Lock()
	defer s.refsMu.Unlock()
	s.refs = make(map[string]RepoRef, len(repos))
	for _, r := range repos {
		s.refs[r.FullName] = r
	}
}

// FetchMainBranch implements MainBranchRefresher (#1316): the default-branch
// row of one repo, read the way Fetch reads every repo's, for a webhook
// delivery that finished a run. A repo no full poll has listed yet is an
// error, so the aggregator keeps whatever row it has.
func (s *GenericSource) FetchMainBranch(ctx context.Context, _, _, fullName string) (MainBranch, error) {
	reader, ok := s.client.(MainBranchReader)
	if !ok {
		return MainBranch{}, fmt.Errorf("dashboard: %s default branch: %w", s.forge, errUnsupportedByClient)
	}
	s.refsMu.Lock()
	repo, known := s.refs[fullName]
	s.refsMu.Unlock()
	if !known {
		return MainBranch{}, fmt.Errorf("dashboard: %s: %w", fullName, errRepoNotListed)
	}
	branch, err := reader.ReadMainBranch(ctx, repo)
	if err != nil {
		return MainBranch{}, fmt.Errorf("dashboard: read default branch: %w", err)
	}
	branch.Forge, branch.FullName, branch.URL = s.forge, repo.FullName, repo.URL
	if branch.FailingJobs == nil {
		branch.FailingJobs = []string{}
	}

	return branch, nil
}
