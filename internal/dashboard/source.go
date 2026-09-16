package dashboard

import "context"

// Result is what one forge contributes to a Snapshot. Health.Reachable is
// false only for a fetch that failed outright (couldn't list repositories
// at all); a single repository's own fetch failing is logged and skipped by
// the Source, not surfaced here — a good forge with one broken repo still
// reports Reachable: true.
type Result struct {
	Health       ForgeHealth
	PullRequests []PullRequest
	Issues       []Issue
	// Repos is every repo this forge is tracking, regardless of whether
	// it currently has anything open — RepoCount alone can't name them,
	// and a repo with zero open pull requests/issues would otherwise
	// never appear in PullRequests/Issues' own Repo fields either.
	Repos []Repo
}

// Source is one forge's half of the aggregate. github.Source and
// forgejo.Source both implement it; the aggregator knows nothing about
// either forge beyond this.
type Source interface {
	Fetch(ctx context.Context) Result
	// Forge reports which forge this Source drives — how RefreshRepo
	// picks the one matching a webhook delivery's own forge out of an
	// Aggregator's sources.
	Forge() Forge
}

// RepoRefresher is implemented by a Source that can refresh just one
// named repository instead of its whole configured scope — checked via
// a type assertion, the same optional-capability pattern RateLimiter
// uses, so a Source with no such shortcut doesn't need a no-op method.
// A webhook delivery already names the exact repo that changed; without
// this, the only way to pick up that change is Fetch's full scope, which
// for a large tracked-repo count is real, avoidable cost on every single
// delivery.
type RepoRefresher interface {
	FetchRepo(ctx context.Context, owner, name, fullName string) (prs []PullRequest, issues []Issue, err error)
}
