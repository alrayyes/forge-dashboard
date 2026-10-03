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
	// Required reports whether the base branch's protection makes this
	// check block the merge. A pointer so "unknown" (nil, omitted from
	// the JSON) stays distinct from "advisory" (false): a token that
	// can't read protection, or a check whose protection name can't be
	// mapped, must not read as advisory.
	Required *bool `json:"required,omitempty"`
}

// ReviewDecision is where a pull request stands on code review. Matches
// components.schemas.ReviewState's decision.
type ReviewDecision string

// The coarse review states both forges can map onto. GitHub reports its
// own reviewDecision (null when no review is required, which becomes
// ReviewNone or a derived value); Forgejo has no such field, so
// DeriveReviewDecision builds one from its reviews and requested reviewers.
const (
	ReviewApproved         ReviewDecision = "approved"
	ReviewChangesRequested ReviewDecision = "changes_requested"
	ReviewRequired         ReviewDecision = "review_required"
	ReviewNone             ReviewDecision = "none"
)

// ReviewState matches components.schemas.ReviewState. A nil
// *ReviewState on PullRequest means the forge couldn't report review
// state, never "no reviews" (that is Decision == ReviewNone).
type ReviewState struct {
	Decision           ReviewDecision `json:"decision"`
	Approvals          int            `json:"approvals"`
	RequestedReviewers int            `json:"requestedReviewers"`
}

// DeriveReviewDecision builds a decision from counts, for forges with no
// decision field of their own: a standing change request wins, then any
// approval, then an outstanding review request, else nothing.
func DeriveReviewDecision(approvals, changesRequested, requested int) ReviewDecision {
	switch {
	case changesRequested > 0:
		return ReviewChangesRequested
	case approvals > 0:
		return ReviewApproved
	case requested > 0:
		return ReviewRequired
	default:
		return ReviewNone
	}
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
	// BaseBranch and HeadBranch name the branch the pull request targets and
	// the branch it comes from (#860). A stack is worked out from them: B is
	// stacked on A when B's base branch is A's head branch.
	BaseBranch string `json:"baseBranch"`
	HeadBranch string `json:"headBranch"`
	// CrossRepository is true when the head branch lives in another
	// repository (a fork). Such a pull request is never part of a stack.
	CrossRepository bool `json:"crossRepository"`
	// Stack, StackedOn and StackChildren say where the pull request sits in
	// a stack of pull requests (#860); AnnotateStacks fills them. Stack and
	// StackedOn are null when there is none, and StackChildren is always a
	// list.
	Stack         *StackPosition `json:"stack"`
	StackedOn     *StackRef      `json:"stackedOn"`
	StackChildren []int          `json:"stackChildren"`
	// RequestedReviewerLogins lists who was asked to review this pull
	// request, by login (#695). Teams have no login and are left out.
	// Always a list, empty when nobody was asked, so a client can range
	// over it without a nil check.
	RequestedReviewerLogins []string `json:"requestedReviewerLogins"`
	// Empty reports whether merging this pull request would produce an
	// empty commit — its content already landed on the base branch some
	// other way (confirmed live: a mechanical version-bump PR whose branch
	// had already been merged into master through another route, leaving
	// Merge silently a no-op with nothing in the UI explaining why).
	// Deliberately conservative rather than
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
	// AutoMergeAllowed is GitHub's per-viewer viewerCanEnableAutoMerge
	// answer (#738): false when GitHub would refuse "Enable auto-merge",
	// e.g. a stacked PR whose base branch has no protection rule. Nil when
	// unknown (the REST fallback, Forgejo), so clients keep today's
	// behaviour rather than treating unknown as refused.
	AutoMergeAllowed *bool `json:"autoMergeAllowed,omitempty"`
	// Review is nil when the forge couldn't report review state (see
	// ReviewState), the same omit-when-unknown shape as AutoMergeEnabled.
	Review *ReviewState `json:"review,omitempty"`
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
	// Severity is how worried a client should be about this budget (#806).
	// The API fills it in when it answers, from the clock, so it never goes
	// stale in a snapshot; it is empty inside the aggregator's own snapshot.
	Severity RateLimitSeverity `json:"severity,omitempty"`
}

// RateLimitSeverity grades a RateLimit. Matches
// components.schemas.RateLimit.severity.
type RateLimitSeverity string

// The grades: Exceeded means the budget is spent and not seen to have
// reset, Low means under lowBudgetFraction of it is left.
const (
	RateLimitOK       RateLimitSeverity = "ok"
	RateLimitLow      RateLimitSeverity = "low"
	RateLimitExceeded RateLimitSeverity = "exceeded"
)

// lowBudgetFraction is the share of a budget below which it counts as low.
// The same 5% cutoff Insights' gauge uses for its critical colour.
const lowBudgetFraction = 0.05

// SeverityAt grades r as of now. A spent budget whose reset time has passed
// is not exceeded any more, since the forge has refilled it; the reading is
// just stale, so it grades low until the next snapshot says otherwise.
func (r RateLimit) SeverityAt(now time.Time) RateLimitSeverity {
	if r.Remaining == 0 && (r.ResetsAt.IsZero() || r.ResetsAt.After(now)) {
		return RateLimitExceeded
	}
	if r.Limit > 0 && float64(r.Remaining)/float64(r.Limit) < lowBudgetFraction {
		return RateLimitLow
	}

	return RateLimitOK
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
	// DependabotCommandsBlocked, when non-empty, is why a "@dependabot"
	// comment sent through this forge's credential would be refused
	// (#666): Dependabot ignores GitHub Apps. The frontend locks the
	// Dependabot buttons with this exact text.
	DependabotCommandsBlocked string `json:"dependabotCommandsBlocked,omitempty"`
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
	// RateLimit is the budget the failing response reported, when it
	// reported one. Lets a write's caller say when a rate limit clears.
	RateLimit *RateLimit
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
