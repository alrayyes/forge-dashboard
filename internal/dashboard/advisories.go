package dashboard

import "context"

// AdvisoryState says whether a repo's advisory answer can be trusted.
// Matches components.schemas.AdvisoryState.
type AdvisoryState string

// Known is an answer the forge gave. Unknown is no answer: alerts switched off,
// a token without the scope, or a read that failed. Unknown is never a zero
// count, since "no data" must not read as "no advisories".
const (
	AdvisoriesKnown   AdvisoryState = "known"
	AdvisoriesUnknown AdvisoryState = "unknown"
)

// AdvisorySeverity is how serious an advisory is, using the four levels
// GitHub's Dependabot alerts use. Matches components.schemas.AdvisorySeverity.
type AdvisorySeverity string

// The four severities, lowest first.
const (
	SeverityLow      AdvisorySeverity = "low"
	SeverityMedium   AdvisorySeverity = "medium"
	SeverityHigh     AdvisorySeverity = "high"
	SeverityCritical AdvisorySeverity = "critical"
)

// Rank orders severities, so the highest of several can be picked. An
// unrecognised value ranks below low.
func (s AdvisorySeverity) Rank() int {
	switch s {
	case SeverityLow:
		return 1
	case SeverityMedium:
		return 2
	case SeverityHigh:
		return 3
	case SeverityCritical:
		return 4
	default:
		return 0
	}
}

// Advisories is what one source knows about open dependency advisories on a
// repo. Matches components.schemas.Advisories.
type Advisories struct {
	State AdvisoryState `json:"state"`
	// Count is the number of open advisories. Zero is only meaningful when
	// State is known.
	Count int `json:"count"`
	// Highest is the worst severity among them, empty when there are none or
	// the state is unknown.
	Highest AdvisorySeverity `json:"highest,omitempty"`
	// URL is where to see the advisories on the forge. Empty when unknown.
	URL string `json:"url,omitempty"`
}

// UnknownAdvisories is the answer when a source can't say.
func UnknownAdvisories() *Advisories {
	return &Advisories{State: AdvisoriesUnknown}
}

// AdvisoryReader is a source of dependency advisories for one repo: GitHub's
// Dependabot alerts today, OSV matches for a Forgejo lockfile later. A new
// provider implements only this. A source that can't answer (alerts off, no
// permission) returns the unknown state with a nil error; an error is reserved
// for a read that failed, which the caller also shows as unknown.
type AdvisoryReader interface {
	ReadAdvisories(ctx context.Context, owner, name, repoURL string) (Advisories, error)
}
