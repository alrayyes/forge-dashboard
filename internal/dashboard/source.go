package dashboard

import (
	"context"
	"net/url"
)

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

// WebhookChecker is implemented by a ForgeClient (or, for github.Client,
// a Source directly) that can report whether a repo already has a
// webhook pointed at this app — checked via a type assertion, the same
// optional-capability pattern RateLimiter uses. A client with no webhook
// path configured reports false for every repo without making an API
// call at all, not an error — the same "optional, degrades quietly"
// shape RateLimit's own nil pointer already uses.
type WebhookChecker interface {
	HasWebhook(ctx context.Context, owner, name string) (bool, error)
}

// WebhookManager is implemented by a ForgeClient (or, for github.Client,
// a Source directly) that can create or update this app's own webhook
// on one of its tracked repos — checked via a type assertion, the same
// optional-capability pattern RepoRefresher uses. A single method
// rather than separate Create/Edit ones: the caller doesn't know or
// care whether a matching hook already exists, only that one ends up
// correctly configured — deciding that, and finding an existing one via
// WebhookTargetsPath rather than creating a duplicate, is the client's
// own job.
type WebhookManager interface {
	EnsureWebhook(ctx context.Context, owner, name, targetURL, secret string) error
}

// PullRequestMerger is implemented by a ForgeClient (or, for github.Client,
// a Source directly) that can merge one of its own pull requests —
// checked via a type assertion, the same optional-capability pattern
// WebhookManager uses. Takes no merge-method override: the caller always
// wants the repo's own configured default, and picking a method is each
// implementation's own job (GitHub asks the forge to pick its default;
// Forgejo's API has no such default and needs it looked up and passed
// explicitly).
type PullRequestMerger interface {
	MergePullRequest(ctx context.Context, owner, name string, number int) error
}

// PullRequestAutoMerger is implemented by a ForgeClient (or, for
// github.Client, a Source directly) that can arm a pull request's own
// native auto-merge — checked via a type assertion, the same
// optional-capability pattern PullRequestMerger uses. Unlike
// MergePullRequest, GitHub's own enablePullRequestAutoMerge mutation
// asks for an explicit merge method rather than picking the repo's
// configured default itself, so implementations look the repo's allowed
// methods up and pick one the same way MergePullRequest's own
// mergeMethodFor does — no override exposed here either (#526).
type PullRequestAutoMerger interface {
	EnableAutoMerge(ctx context.Context, owner, name string, number int) error
}

// PullRequestCloser is implemented by a ForgeClient (or, for github.Client,
// a Source directly) that can close one of its own pull requests without
// merging it — checked via a type assertion, the same optional-capability
// pattern PullRequestMerger uses. For a PR that turns out not to need
// merging at all (a duplicate, one whose content already landed another
// way — confirmed live on homelab/vps-docker#561), Close is the action
// that actually applies, not Merge.
type PullRequestCloser interface {
	ClosePullRequest(ctx context.Context, owner, name string, number int) error
}

// BranchUpdater is implemented by a ForgeClient (or, for github.Client, a
// Source directly) that can bring one of its own pull requests' head
// branch up to date with its base — checked via a type assertion, the
// same optional-capability pattern PullRequestMerger uses. accepted is
// true only for GitHub's async case (the update was scheduled as a
// background job, not finished yet, per GitHub's own PullRequestsService
// .UpdateBranch doc comment); every other outcome — Forgejo's own
// synchronous update, or GitHub's synchronous 200/201 case — returns
// false, since the update had already finished by the time this returns.
type BranchUpdater interface {
	UpdateBranch(ctx context.Context, owner, name string, number int) (accepted bool, err error)
}

// PullRequestCommenter is implemented by a ForgeClient (or, for
// github.Client, a Source directly) that can post a comment on one of its
// own pull requests — checked via a type assertion, the same
// optional-capability pattern BranchUpdater uses. Takes a plain body
// rather than exposing separate per-command methods: Dependabot's own
// comment-command interface (`@dependabot rebase`, `@dependabot recreate`)
// is just a PR comment with specific text, and it's the caller's job (the
// API handler, not this port) to restrict which bodies actually get sent
// rather than exposing a generic "post any comment" capability.
type PullRequestCommenter interface {
	CommentPullRequest(ctx context.Context, owner, name string, number int, body string) error
}

// PullRequestLabeler is implemented by a ForgeClient (or, for
// github.Client, a Source directly) that can add a label to one of its
// own pull requests — checked via a type assertion, the same
// optional-capability pattern PullRequestCommenter uses. Implemented by
// both forges, unlike PullRequestCommenter: Renovate's own rebase/retry
// trigger is adding its configured label, and Renovate runs on GitHub
// and Forgejo alike.
type PullRequestLabeler interface {
	AddLabel(ctx context.Context, owner, name string, number int, label string) error
}

// PullRequestChecker is implemented by a ForgeClient (or, for
// github.Client, a Source directly) that can list the individual
// job/check runs against one of its own pull requests' head commit —
// checked via a type assertion, the same optional-capability pattern
// PullRequestLabeler uses. Fetched on demand by its own handler, never as
// part of a Source's own Fetch/FetchRepo: the eager refresh loop already
// re-fetches every open PR's collapsed CIStatus on its own cadence, and
// adding a per-job fetch to that same loop would multiply its cost by
// every open PR on every refresh for detail most PRs' rows are never
// opened for.
type PullRequestChecker interface {
	ListChecks(ctx context.Context, owner, name string, number int) ([]Check, error)
}

// WebhookTargetsPath reports whether rawURL's path component is exactly
// path — how a Source recognizes "this hook is the one forge-dashboard
// itself would have created," regardless of the scheme or host a webhook
// was configured against. Matching on the path alone, not the full URL,
// is deliberate: this process may sit behind a reverse proxy whose
// public origin it has no independent way to know, and the webhook
// token in the path is already unique enough (256 bits of randomness)
// that a path match carries no real collision risk. An unparseable
// rawURL, or an empty path, never matches.
func WebhookTargetsPath(rawURL, path string) bool {
	if path == "" {
		return false
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}

	return u.Path == path
}
