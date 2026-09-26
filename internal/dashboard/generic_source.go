package dashboard

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
)

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

	type repoResult struct {
		prs        []PullRequest
		issues     []Issue
		hasWebhook bool
	}

	checker, checksWebhooks := s.client.(WebhookChecker)

	results := make([]repoResult, len(repos))
	sem := make(chan struct{}, s.maxConcurrency)
	var wg sync.WaitGroup

	for i, repo := range repos {
		wg.Add(1)
		go func(i int, repo RepoRef) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			prs, err := s.client.ListOpenPullRequests(ctx, repo.Owner, repo.Name, repo.FullName)
			if err != nil {
				slog.Warn("list pull requests failed", "forge", s.forge, "repo", repo.FullName, "error", err)
			}
			issues, err := s.client.ListOpenIssues(ctx, repo.Owner, repo.Name, repo.FullName)
			if err != nil {
				slog.Warn("list issues failed", "forge", s.forge, "repo", repo.FullName, "error", err)
			}
			var hasWebhook bool
			if checksWebhooks {
				hasWebhook, err = checker.HasWebhook(ctx, repo.Owner, repo.Name)
				if err != nil {
					slog.Warn("webhook check failed", "forge", s.forge, "repo", repo.FullName, "error", err)
				}
			}
			results[i] = repoResult{prs: prs, issues: issues, hasWebhook: hasWebhook}
		}(i, repo)
	}
	wg.Wait()

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
	for _, r := range results {
		result.PullRequests = append(result.PullRequests, r.prs...)
		result.Issues = append(result.Issues, r.issues...)
	}

	return result
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
		return fmt.Errorf("dashboard: %s's client can't manage webhooks", s.forge)
	}
	if err := manager.EnsureWebhook(ctx, owner, name, targetURL, secret); err != nil {
		return fmt.Errorf("dashboard: ensure webhook: %w", err)
	}

	return nil
}

// MergePullRequest implements PullRequestMerger at the Source level by
// delegating to the underlying client, the same "Source unwraps to its
// ForgeClient" shape EnsureWebhook already uses.
func (s *GenericSource) MergePullRequest(ctx context.Context, owner, name string, number int) error {
	merger, ok := s.client.(PullRequestMerger)
	if !ok {
		return fmt.Errorf("dashboard: %s's client can't merge pull requests", s.forge)
	}
	if err := merger.MergePullRequest(ctx, owner, name, number); err != nil {
		return fmt.Errorf("dashboard: merge pull request: %w", err)
	}

	return nil
}

// UpdateBranch implements BranchUpdater at the Source level by delegating
// to the underlying client, the same "Source unwraps to its ForgeClient"
// shape EnsureWebhook/MergePullRequest already use.
func (s *GenericSource) UpdateBranch(ctx context.Context, owner, name string, number int) (bool, error) {
	updater, ok := s.client.(BranchUpdater)
	if !ok {
		return false, fmt.Errorf("dashboard: %s's client can't update pull request branches", s.forge)
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
		return fmt.Errorf("dashboard: %s's client can't close pull requests", s.forge)
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
		return nil, fmt.Errorf("dashboard: %s's client can't list pull request checks", s.forge)
	}
	checks, err := checker.ListChecks(ctx, owner, name, number)
	if err != nil {
		return nil, fmt.Errorf("dashboard: list checks: %w", err)
	}

	return checks, nil
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
