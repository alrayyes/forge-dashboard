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

// AdvisoryReason says why an advisory answer is unknown. Matches
// components.schemas.AdvisoryReason.
type AdvisoryReason string

// The causes the dashboard can tell apart. Refused is a 403 (a credential
// without the Dependabot alerts permission), SwitchedOff a 404 (alerts off on
// the repo), Throttled a rate limit that clears by itself, Failed any other
// error, TooMany a repo with more open alerts than one read pages through.
const (
	ReasonRefused     AdvisoryReason = "refused"
	ReasonSwitchedOff AdvisoryReason = "switched_off"
	ReasonThrottled   AdvisoryReason = "throttled"
	ReasonFailed      AdvisoryReason = "failed"
	ReasonTooMany     AdvisoryReason = "too_many"
	// ReasonNotEnabled is a source the operator has not switched on, so the
	// repo was not checked.
	ReasonNotEnabled AdvisoryReason = "not_enabled"
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
	// Reason says why the state is unknown, when the dashboard knows. Empty
	// when the state is known or the cause is not known.
	Reason AdvisoryReason `json:"reason,omitempty"`
}

// UnknownAdvisories is the answer when a source can't say.
func UnknownAdvisories() *Advisories {
	return &Advisories{State: AdvisoriesUnknown}
}

// AdvisoryReader is a source of dependency advisories for one repo: GitHub's
// Dependabot alerts, OSV matches for a Forgejo lock file. A new provider
// implements only this. A source that can't answer (alerts off, no permission,
// advisories not enabled) returns the unknown state with a nil error; an error
// is reserved for a read that failed, which the caller also shows as unknown.
type AdvisoryReader interface {
	ReadAdvisories(ctx context.Context, owner, name, repoURL string) (Advisories, error)
}
