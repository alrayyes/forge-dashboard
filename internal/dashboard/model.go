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
}

// ForgeHealth matches components.schemas.ForgeHealth.
type ForgeHealth struct {
	Forge     Forge      `json:"forge"`
	Reachable bool       `json:"reachable"`
	Error     string     `json:"error,omitempty"`
	RepoCount int        `json:"repoCount"`
	RateLimit *RateLimit `json:"rateLimit,omitempty"`
}

// Snapshot matches components.schemas.Dashboard — the whole body
// GET /api/dashboard answers with.
type Snapshot struct {
	GeneratedAt  time.Time     `json:"generatedAt"`
	Forges       []ForgeHealth `json:"forges"`
	PullRequests []PullRequest `json:"pullRequests"`
	Issues       []Issue       `json:"issues"`
}

// newEmptySnapshot never has nil slices: the API contract promises arrays,
// not null, even before the first successful refresh.
func newEmptySnapshot() Snapshot {
	return Snapshot{
		Forges:       []ForgeHealth{},
		PullRequests: []PullRequest{},
		Issues:       []Issue{},
	}
}
