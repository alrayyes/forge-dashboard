package dashboard

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
)

// ActionCode is why a pull request action (Merge today) was refused, from a
// fixed set every client shares. Matches components.schemas.ActionError.code.
type ActionCode string

// The codes, one per reason a client can act on differently.
const (
	ActionAlreadyMerged       ActionCode = "already_merged"
	ActionAlreadyClosed       ActionCode = "already_closed"
	ActionNotMergeable        ActionCode = "not_mergeable"
	ActionConflict            ActionCode = "conflict"
	ActionBehind              ActionCode = "behind"
	ActionChecksPending       ActionCode = "checks_pending"
	ActionChecksFailing       ActionCode = "checks_failing"
	ActionBlockedByProtection ActionCode = "blocked_by_protection"
	ActionPermission          ActionCode = "permission"
	ActionRateLimited         ActionCode = "rate_limited"
	ActionUnknown             ActionCode = "unknown"
)

// ActionRefusal is the classified outcome of a refused action. Message is
// short plain words safe to show a person. ResetsAt is set only for
// ActionRateLimited, and only when the forge said when.
type ActionRefusal struct {
	Code     ActionCode
	Message  string
	ResetsAt *time.Time
}

// PullRequestState is a live re-read of one pull request, just enough to
// explain why an action on it was refused. Forge-neutral: GitHub fills the
// flags from mergeable_state, Forgejo (which has no equivalent) only knows
// merged, closed and an overall not-mergeable verdict (Blocked).
type PullRequestState struct {
	Merged        bool
	Closed        bool
	Draft         bool
	Conflicting   bool
	Behind        bool
	Blocked       bool
	ChecksFailing bool
}

// PullRequestStateReader is implemented by a ForgeClient (or, for
// github.Client, a Source directly) that can re-read one pull request's
// current state — checked via a type assertion, the same optional-
// capability pattern PullRequestMerger uses.
type PullRequestStateReader interface {
	ReadPullRequestState(ctx context.Context, owner, name string, number int) (PullRequestState, error)
}

// forgeDiagnosticPrefix is the "github: PUT /path: " wrapper every forge
// client puts in front of the forge's own text.
var forgeDiagnosticPrefix = regexp.MustCompile(`^(?:github|forgejo): \S+ \S+: (.+)$`)

// ForgeMessage returns the forge's own reason with the diagnostic prefix
// stripped, for showing next to the button it explains.
func ForgeMessage(err error) string {
	msg := err.Error()
	if m := forgeDiagnosticPrefix.FindStringSubmatch(msg); m != nil {
		return m[1]
	}

	return msg
}

// ClassifyActionRefusal maps a refused action plus a re-read of the pull
// request's state onto the shared code set. state is nil when it wasn't
// (or couldn't be) read; the result is then ActionUnknown carrying the
// forge's own message, except for refusals that need no re-read: a
// permission or rate-limit refusal says all there is to say by itself.
// Built for every pull request action, not just Merge.
func ClassifyActionRefusal(actionErr error, state *PullRequestState) ActionRefusal {
	if clientErr, ok := errors.AsType[*ClientError](actionErr); ok {
		switch clientErr.Kind {
		case ForgeErrorRateLimited:
			r := ActionRefusal{Code: ActionRateLimited, Message: "The forge's API rate limit is reached. Try again once it resets."}
			if clientErr.RateLimit != nil && !clientErr.RateLimit.ResetsAt.IsZero() {
				at := clientErr.RateLimit.ResetsAt
				r.ResetsAt = &at
			}

			return r
		case ForgeErrorUnauthorized:
			return ActionRefusal{Code: ActionPermission, Message: "Missing permission — check your token in Settings."}
		}
	}
	forgeText := ForgeMessage(actionErr)
	if state == nil {
		return ActionRefusal{Code: ActionUnknown, Message: forgeText}
	}

	if r, ok := refusalFromFlags(state); ok {
		return r
	}

	lower := strings.ToLower(forgeText)
	if strings.Contains(lower, "status check") {
		if strings.Contains(lower, "fail") {
			return ActionRefusal{Code: ActionChecksFailing, Message: "A required check is failing. Fix it, then merge."}
		}

		return ActionRefusal{Code: ActionChecksPending, Message: "A required check hasn't finished. Merge once it passes."}
	}
	if state.Blocked {
		return ActionRefusal{Code: ActionBlockedByProtection, Message: "Blocked by branch protection: a required review or check is missing."}
	}
	if strings.Contains(lower, "not mergeable") {
		return ActionRefusal{Code: ActionNotMergeable, Message: "No longer mergeable. Refresh to see the current state."}
	}

	return ActionRefusal{Code: ActionNotMergeable, Message: forgeText}
}

// refusalFromFlags is the part of the classification the re-read alone
// decides, without the forge's own text.
func refusalFromFlags(state *PullRequestState) (ActionRefusal, bool) {
	switch {
	case state.Merged:
		return ActionRefusal{Code: ActionAlreadyMerged, Message: "This pull request was already merged."}, true
	case state.Closed:
		return ActionRefusal{Code: ActionAlreadyClosed, Message: "This pull request was closed without merging."}, true
	case state.Conflicting:
		return ActionRefusal{Code: ActionConflict, Message: "Merge conflict. Resolve it on the forge, then merge."}, true
	case state.Behind:
		return ActionRefusal{Code: ActionBehind, Message: "Behind the base branch. Bring it up to date, then merge."}, true
	case state.Draft:
		return ActionRefusal{Code: ActionNotMergeable, Message: "Draft pull request. Mark it ready for review to merge."}, true
	case state.ChecksFailing:
		return ActionRefusal{Code: ActionChecksFailing, Message: "A check is failing. Fix it, then merge."}, true
	}

	return ActionRefusal{}, false
}
