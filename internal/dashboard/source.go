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
}

// Source is one forge's half of the aggregate. github.Source and
// forgejo.Source both implement it; the aggregator knows nothing about
// either forge beyond this.
type Source interface {
	Fetch(ctx context.Context) Result
}
