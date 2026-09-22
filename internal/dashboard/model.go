// Package dashboard holds the domain model both forge clients produce and
// the aggregator that merges them into one snapshot. Neither forge client
// depends on the other; both only depend on this package's types.
package dashboard

import "time"

// Forge names one of the two forges this service talks to. Matches
// components.schemas.Forge in api/openapi.yaml.
type Forge string

// The only two forges this service knows how to talk to.
const (
	ForgeGitHub  Forge = "github"
	ForgeForgejo Forge = "forgejo"
)

// CIStatus is the combined result across every check reported against a
// pull request's head commit. Matches components.schemas.CIStatus.
type CIStatus string

// The combined result across every check on a pull request's head commit.
const (
	CISuccess CIStatus = "success"
	CIFailure CIStatus = "failure"
	CIPending CIStatus = "pending"
	CINone    CIStatus = "none"
)

// MergeStatus is a pull request's mergeable/blocked state, as coarse as
// every forge this service talks to can agree on. Matches
// components.schemas.MergeStatus.
type MergeStatus string

// A forge only ever reports a handful of real distinctions here — GitHub's
// own mergeStateStatus has eight values, Forgejo's SDK has one plain bool
// — so this stays deliberately coarse rather than chasing GitHub's full
// enum. MergeUnknown covers both "the forge itself doesn't know yet" and
// "this service couldn't determine it."
const (
	MergeMergeable   MergeStatus = "mergeable"
	MergeConflicting MergeStatus = "conflicting"
	MergeBlocked     MergeStatus = "blocked"
	MergeUnknown     MergeStatus = "unknown"
)

// Label matches components.schemas.Label — a label's name and its real
// colour from the forge, not just the name.
type Label struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

// CheckState is one job/check's own status — the per-job detail CIStatus
// deliberately doesn't carry, since CIStatus is the combined result across
// every one of them. Matches components.schemas.CheckState.
type CheckState string

// The states a single check/job can be in, coarse enough for both forges'
// real values to map onto: GitHub's check-run status/conclusion pair and
// combined-status "state", and Forgejo/Gitea Actions' own job status.
const (
	CheckQueued    CheckState = "queued"
	CheckRunning   CheckState = "running"
	CheckSuccess   CheckState = "success"
	CheckFailure   CheckState = "failure"
	CheckCancelled CheckState = "cancelled"
	CheckSkipped   CheckState = "skipped"
	CheckTimedOut  CheckState = "timed_out"
)

// Check is one job/check run against a pull request's head commit — the
// per-job list a pipeline detail view shows, fetched on demand rather than
// eagerly for every PR on every refresh (see dashboard.PullRequestChecker).
// Matches components.schemas.Check.
type Check struct {
	Name  string     `json:"name"`
	State CheckState `json:"state"`
	// URL is that job's own page on the forge that ran it — a GitHub
	// Actions job page, a Forgejo Actions job page, or a third-party CI's
	// own details page for the legacy commit-status case — never the
	// pull request's own page.
	URL string `json:"url"`
}

// PullRequest matches components.schemas.PullRequest in api/openapi.yaml.
type PullRequest struct {
	Forge       Forge       `json:"forge"`
	Repo        string      `json:"repo"`
	Number      int         `json:"number"`
	Title       string      `json:"title"`
	URL         string      `json:"url"`
	Author      string      `json:"author"`
	Draft       bool        `json:"draft"`
	Labels      []Label     `json:"labels"`
	CreatedAt   time.Time   `json:"createdAt"`
	UpdatedAt   time.Time   `json:"updatedAt"`
	CI          CIStatus    `json:"ci"`
	MergeStatus MergeStatus `json:"mergeStatus"`
	// Behind is deliberately its own field, not folded into MergeStatus,
	// because the two aren't mutually exclusive on every forge: confirmed
	// live against a real Forgejo instance (a PR's own Mergeable field
	// stayed true after a new commit landed on its base, since Forgejo
	// doesn't recompute it synchronously — see mergeStatusFromMergeable's
	// own doc comment) — so a Forgejo PR can be both "mergeable" and
	// "behind" at once, and folding this into MergeStatus would force
	// picking one and losing the other. GitHub's mergeStateStatus is a
	// single enum where BEHIND and CLEAN can't both be true, but this
	// field stays orthogonal there too, for the same reason CI sits
	// beside MergeStatus rather than inside it: one fact per field.
	Behind bool `json:"behind"`
	// Empty reports whether merging this pull request would produce an
	// empty commit — its content already landed on the base branch some
	// other way (confirmed live: homelab/vps-docker#583, a mechanical
	// version-bump PR whose branch had already been merged into master
	// through another route, leaving Merge silently a no-op with nothing
	// in the UI explaining why). Deliberately conservative rather than
	// nilable like AutoMergeEnabled: a source that can't tell (the
	// unauthenticated GitHub REST fallback, or a Forgejo pull request
	// whose Additions/Deletions/ChangedFiles came back nil) just leaves
	// this false, the same as a real non-empty diff — never a false
	// positive that would hide Merge on a pull request that still has
	// something to merge.
	Empty bool `json:"empty"`
	// AutoMergeEnabled is nil when the owning forge has no way to report
	// this at all (Forgejo, today) — the same "doesn't report it" shape
	// RateLimit's own nilable pointer already uses, so a forge with
	// nothing to say here never renders as a false "not enabled."
	AutoMergeEnabled *bool `json:"autoMergeEnabled,omitempty"`
}

// Issue matches components.schemas.Issue in api/openapi.yaml.
type Issue struct {
	Forge     Forge     `json:"forge"`
	Repo      string    `json:"repo"`
	Number    int       `json:"number"`
	Title     string    `json:"title"`
	URL       string    `json:"url"`
	Author    string    `json:"author"`
	Labels    []Label   `json:"labels"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// RateLimit matches components.schemas.RateLimit — the forge API's own
// request budget for the credential the last refresh used. Only some
// forges expose this (GitHub does, Forgejo doesn't by default), so it's
// always a pointer: nil means "this forge doesn't report one," not "the
// budget is zero."
type RateLimit struct {
	Limit     int       `json:"limit"`
	Remaining int       `json:"remaining"`
	ResetsAt  time.Time `json:"resetsAt"`
	// Cost is the actual point price GitHub charged the call that
	// populated this value — GraphQL-specific (#440): REST's own budget
	// is a plain per-request count with no separate cost concept, so
	// RateLimitREST's own RateLimit never sets this, and it stays at its
	// zero value there rather than a fabricated 1.
	Cost int `json:"cost,omitempty"`
}

// ForgeErrorKind classifies why a forge is unreachable, or why a write to
// it was rejected, into a small, coarse set of actionable categories.
// Matches components.schemas.ForgeErrorKind. Empty string is the zero
// value: "nothing to classify," only ever meaningful alongside a
// non-empty ForgeHealth.Error.
type ForgeErrorKind string

// A forge failure only needs to tell the user one of a handful of things
// to do about it — retry, check a token, check a URL, wait out a rate
// limit — so this stays as coarse as MergeStatus does, rather than
// chasing every status code a forge can return.
const (
	ForgeErrorUnreachable  ForgeErrorKind = "unreachable"
	ForgeErrorUnauthorized ForgeErrorKind = "unauthorized"
	ForgeErrorNotFound     ForgeErrorKind = "not_found"
	ForgeErrorRateLimited  ForgeErrorKind = "rate_limited"
	// ForgeErrorConflict is only ever returned from a pull-request write —
	// the forge reports the PR itself isn't currently mergeable, either a
	// real conflict or a state that changed since the dashboard's last
	// refresh.
	ForgeErrorConflict ForgeErrorKind = "conflict"
	ForgeErrorUnknown  ForgeErrorKind = "unknown"
)

// forgeErrorDetails maps each ForgeErrorKind to a plain-language sentence
// safe to show behind the forge-health panel's "Show details" disclosure —
// the counterpart to app.js's own ERROR_HEADLINES map, one level more
// detailed but never the raw wire-format error text (#360: a real
// incident showed a raw "github: graphql: API rate limit exceeded for
// user ID 511318" string there, internal phrasing including a numeric
// account ID nobody outside this codebase should see).
var forgeErrorDetails = map[ForgeErrorKind]string{
	ForgeErrorUnreachable:  "The forge didn't respond, or the connection to it failed.",
	ForgeErrorUnauthorized: "The saved credential was rejected — it may be missing, expired, or revoked.",
	ForgeErrorNotFound:     "The configured instance URL doesn't match anything reachable.",
	ForgeErrorRateLimited:  "This account's request budget with the forge is used up for now.",
	ForgeErrorConflict:     "The forge reported the change is no longer possible as requested.",
}

// HumanizeForgeError returns forgeErrorDetails' sentence for kind, or a
// generic fallback for ForgeErrorUnknown and any kind this map hasn't
// been taught yet — never the underlying error's own text. The real
// error is still logged server-side (see GenericSource.Fetch's own
// slog.Warn call) for whoever operates this instance; it just never
// reaches a client.
func HumanizeForgeError(kind ForgeErrorKind) string {
	if msg, ok := forgeErrorDetails[kind]; ok {
		return msg
	}

	return "An unexpected error occurred talking to the forge."
}

// ForgeHealth matches components.schemas.ForgeHealth.
type ForgeHealth struct {
	Forge     Forge          `json:"forge"`
	Reachable bool           `json:"reachable"`
	Error     string         `json:"error,omitempty"`
	ErrorKind ForgeErrorKind `json:"errorKind,omitempty"`
	RepoCount int            `json:"repoCount"`
	// RateLimitGraphQL and RateLimitREST are two independent budgets
	// (#361) — GitHub tracks REST and GraphQL as separate 5000/hour
	// allowances, so a client spending both (this codebase's GitHub
	// client does: the main query is GraphQL, checkWebhooks and every
	// write action are REST) has two numbers to report, not one. Nil
	// independently: a forge that only ever makes REST calls (Forgejo,
	// through GenericSource) never populates RateLimitGraphQL at all,
	// and RateLimitREST stays nil on a poll that made no REST calls
	// (no webhook path configured).
	RateLimitGraphQL *RateLimit `json:"rateLimitGraphQL,omitempty"`
	RateLimitREST    *RateLimit `json:"rateLimitREST,omitempty"`
}

// ClientError carries a ForgeErrorKind classification alongside the
// underlying error, the same "structured data alongside a message
// string" shape internal/github's own apiError.rateLimit already uses —
// promoted to this package because GenericSource.Fetch, which builds
// ForgeHealth for any ForgeClient-driven forge, can't see an unexported
// type in the client package that produced the error.
type ClientError struct {
	Kind ForgeErrorKind
	Err  error
}

func (e *ClientError) Error() string {
	return e.Err.Error()
}

func (e *ClientError) Unwrap() error {
	return e.Err
}

// Repo names one tracked repository, independent of whether it currently
// has any open pull request or issue — RepoCount alone can only answer
// "how many," and some consumers (webhook-coverage reporting) need
// "which," including a repo with nothing open at all right now. Matches
// components.schemas.Repo.
type Repo struct {
	Forge    Forge  `json:"forge"`
	FullName string `json:"fullName"`
	// URL is the repo's own page on its forge, for linking out — GitHub's
	// is always github.com/<fullName> (this app has no GitHub Enterprise
	// support to point elsewhere); Forgejo's comes straight from the
	// forge's own API response, since the instance URL isn't otherwise
	// tracked per repo.
	URL string `json:"url"`
	// HasWebhook is a live signal from the Source itself — the forge's
	// own webhook list, matched against this app's expected URL — not
	// the settings.Store delivery table. False here doesn't mean "no
	// webhook confirmed at all": the API layer ORs this with the
	// delivery-based signal, since a Source with no webhook path
	// configured, or whose live check failed, always reports false.
	HasWebhook bool `json:"hasWebhook"`
	// CanManageWebhooks reports whether the signed-in user's own
	// permission on this repo is enough to list/create its webhooks —
	// GitHub requires ADMIN specifically (WRITE/MAINTAIN can push but
	// still 404 on GET .../hooks, indistinguishable from the repo not
	// existing, by GitHub's own design); Forgejo's equivalent is
	// Permissions.Admin. False for every repo reached through an
	// unauthenticated, username-only listing, since there's no
	// credential to manage anything with. This is a point-in-time
	// snapshot from the same listing call HasWebhook comes from — a
	// permission change since the last refresh can still make a
	// following EnsureWebhook call fail despite this having said true.
	CanManageWebhooks bool `json:"canManageWebhooks"`
}

// Snapshot matches components.schemas.Dashboard — the whole body
// GET /api/dashboard answers with.
type Snapshot struct {
	GeneratedAt  time.Time     `json:"generatedAt"`
	Forges       []ForgeHealth `json:"forges"`
	PullRequests []PullRequest `json:"pullRequests"`
	Issues       []Issue       `json:"issues"`
	Repos        []Repo        `json:"repos"`
}

// newEmptySnapshot never has nil slices: the API contract promises arrays,
// not null, even before the first successful refresh.
func newEmptySnapshot() Snapshot {
	return Snapshot{
		Forges:       []ForgeHealth{},
		PullRequests: []PullRequest{},
		Issues:       []Issue{},
		Repos:        []Repo{},
	}
}
