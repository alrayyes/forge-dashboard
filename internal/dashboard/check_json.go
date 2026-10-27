package dashboard

// CheckStatus is how far a job has got, one of the two facts a check carries
// on the wire. Matches components.schemas.CheckStatus.
type CheckStatus string

// The statuses a job can report. "waiting" is a GitHub workflow run held until
// a maintainer approves it: it has no jobs yet.
const (
	CheckStatusQueued     CheckStatus = "queued"
	CheckStatusInProgress CheckStatus = "in_progress"
	CheckStatusCompleted  CheckStatus = "completed"
	CheckStatusWaiting    CheckStatus = "waiting"
)

// CheckConclusion is how a finished job ended, the other wire fact. It is
// empty until the status is "completed". Matches
// components.schemas.CheckConclusion.
type CheckConclusion string

// The conclusions a finished job can have, coarse enough for both forges.
const (
	CheckConclusionSuccess   CheckConclusion = "success"
	CheckConclusionFailure   CheckConclusion = "failure"
	CheckConclusionCancelled CheckConclusion = "cancelled"
	CheckConclusionSkipped   CheckConclusion = "skipped"
	CheckConclusionTimedOut  CheckConclusion = "timed_out"
)

// checkFacts splits the server's own one-word state into the status and
// conclusion the stream sends. The page grades them back into what it shows.
func checkFacts(state CheckState) (CheckStatus, CheckConclusion) {
	switch state {
	case CheckQueued:
		return CheckStatusQueued, ""
	case CheckRunning:
		return CheckStatusInProgress, ""
	case CheckAwaitingApproval:
		return CheckStatusWaiting, ""
	case CheckSuccess:
		return CheckStatusCompleted, CheckConclusionSuccess
	case CheckFailure:
		return CheckStatusCompleted, CheckConclusionFailure
	case CheckCancelled:
		return CheckStatusCompleted, CheckConclusionCancelled
	case CheckSkipped:
		return CheckStatusCompleted, CheckConclusionSkipped
	case CheckTimedOut:
		return CheckStatusCompleted, CheckConclusionTimedOut
	default:
		return "", ""
	}
}

// WithFacts fills in each check's status and conclusion from its State, the
// last step before the checks leave the server. State stays the server's own
// shorthand for deciding rerun, cancel and the main branch counts; the status
// and conclusion are what the stream and the MCP tools send. It returns a
// copy, so a source's own list is not changed.
func WithFacts(checks []Check) []Check {
	if checks == nil {
		return nil
	}

	out := make([]Check, len(checks))
	for i, c := range checks {
		c.Status, c.Conclusion = checkFacts(c.State)
		out[i] = c
	}

	return out
}
