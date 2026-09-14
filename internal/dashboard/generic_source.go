package dashboard

import (
	"context"
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

// Fetch implements Source by listing repos, then fetching each one's open
// pull requests and issues concurrently, bounded by maxConcurrency. A
// single repo's failure is logged and skipped, not fatal to the forge.
func (s *GenericSource) Fetch(ctx context.Context) Result {
	repos, err := s.client.ListRepos(ctx)
	if err != nil {
		slog.Warn("forge unreachable", "forge", s.forge, "error", err)
		return Result{Health: ForgeHealth{Forge: s.forge, Reachable: false, Error: err.Error()}}
	}

	type repoResult struct {
		prs    []PullRequest
		issues []Issue
	}

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
			results[i] = repoResult{prs: prs, issues: issues}
		}(i, repo)
	}
	wg.Wait()

	result := Result{Health: ForgeHealth{Forge: s.forge, Reachable: true, RepoCount: len(repos)}}
	if rl, ok := s.client.(RateLimiter); ok {
		limit, err := rl.RateLimit(ctx)
		if err != nil {
			slog.Warn("rate limit check failed", "forge", s.forge, "error", err)
		} else {
			result.Health.RateLimit = &limit
		}
	}
	for _, r := range results {
		result.PullRequests = append(result.PullRequests, r.prs...)
		result.Issues = append(result.Issues, r.issues...)
	}
	return result
}
