package dashboard

import "time"

// QueuedStatus is where a queued action stands.
type QueuedStatus string

// The statuses of a queued action. Queued waits for the reset. The other three
// are final: done ran, skipped found the pull request no longer needed it, and
// failed ran and the forge refused.
const (
	QueuedWaiting QueuedStatus = "queued"
	QueuedDone    QueuedStatus = "done"
	QueuedSkipped QueuedStatus = "skipped"
	QueuedFailed  QueuedStatus = "failed"
)

// QueuedAction is a safe action a user asked to run once a rate-limited forge
// resets (#756). The server owns it, per user, so a reload or a restart shows
// it again. It matches components.schemas.QueuedAction.
type QueuedAction struct {
	ID     string       `json:"id"`
	Action ActionName   `json:"action"`
	Forge  Forge        `json:"forge"`
	Repo   string       `json:"fullName"`
	Number int          `json:"number"`
	Status QueuedStatus `json:"status"`
	// RunAt is when the forge's budget comes back, which is when the server
	// looks at the pull request again and decides.
	RunAt     time.Time `json:"runAt"`
	CreatedAt time.Time `json:"createdAt"`
	// FinishedAt, Code and Message are set once the status is final. Code is
	// from the ActionCode set (already_merged, conflict, rate_limited...), and
	// Message is plain words safe to show a person.
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	Code       ActionCode `json:"code,omitempty"`
	Message    string     `json:"message,omitempty"`
}

// QueueableAction reports whether an action may be queued. Only the safe,
// idempotent ones are: each is re-checked when it runs and does nothing if it
// no longer applies. Merge and Close are not, since they would act unattended
// on a pull request whose checks or commits may have changed; for merging,
// the forge's own auto-merge covers waiting for the reset.
func QueueableAction(a ActionName) bool {
	switch a {
	case ActionUpdateBranch, ActionDependabotRebase, ActionRenovateRebase:
		return true
	}

	return false
}

// RateLimitedUntil reports whether forge in snap has a spent budget whose reset
// is still ahead of now, and when the last such budget comes back. The later
// one wins because the re-check at run time needs every budget: the action
// itself uses REST and the fresh read of the board may use GraphQL.
func RateLimitedUntil(snap Snapshot, forge Forge, now time.Time) (time.Time, bool) {
	var until time.Time
	for _, h := range snap.Forges {
		if h.Forge != forge {
			continue
		}
		for _, rl := range [2]*RateLimit{h.RateLimitGraphQL, h.RateLimitREST} {
			if rl != nil && rl.Limit > 0 && rl.Remaining == 0 && rl.ResetsAt.After(now) && rl.ResetsAt.After(until) {
				until = rl.ResetsAt
			}
		}
	}

	return until, !until.IsZero()
}
