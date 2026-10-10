package dashboard

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// ActionCode is why a pull request action was refused, from a fixed set
// every client shares. Matches components.schemas.ActionError.code.
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
	// The next four belong to one action each.
	ActionAlreadyUpToDate     ActionCode = "already_up_to_date"
	ActionAutoMergeNotAllowed ActionCode = "auto_merge_not_allowed"
	ActionReadyToMerge        ActionCode = "ready_to_merge"
	ActionLabelMissing        ActionCode = "label_missing"
	ActionPermission          ActionCode = "permission"
	ActionRateLimited         ActionCode = "rate_limited"
	ActionStacked             ActionCode = "stacked"
	// ActionAlreadyRequested: a Renovate rebase is already asked for (its
	// rebase-check box is ticked), so asking again does nothing.
	ActionAlreadyRequested ActionCode = "already_requested"
	ActionUnknown          ActionCode = "unknown"
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
// merged, closed, draft and an overall not-mergeable verdict, which it
// reports as ConflictUnconfirmed or, for an empty diff, Blocked.
type PullRequestState struct {
	Merged        bool
	Closed        bool
	Draft         bool
	Conflicting   bool
	Behind        bool
	Blocked       bool
	ChecksFailing bool
	// ConflictUnconfirmed is set when the forge says the pull request isn't
	// mergeable but can't say why. Forgejo's mergeable flag is false for a
	// conflict, and equally while it is still checking or when the check
	// errored, so a conflict is the probable cause and not a proven one.
	ConflictUnconfirmed bool
	// ChangesWorkflows is set when the pull request changes a file under
	// .github/workflows/. GitHub won't update such a branch for an app
	// without the Workflows permission (#919).
	ChangesWorkflows bool
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

// ClassifyForgeRefusal classifies a refused forge call that has no pull
// request to re-read, such as creating a webhook on a repo (#762). It shares
// the permission and rate-limit codes with pull request actions, so a client
// handles one set. A repo the forge can't find gets code unknown with its own
// plain message, since a webhook ensure is the only caller that needs it.
func ClassifyForgeRefusal(err error) ActionRefusal {
	if r, ok := refusalFromKind(err); ok {
		return r
	}
	if clientErr, ok := errors.AsType[*ClientError](err); ok && clientErr.Kind == ForgeErrorNotFound {
		return ActionRefusal{Code: ActionUnknown, Message: "The forge couldn't find this repo, or the token can't see it."}
	}

	return unknownRefusal(err, ForgeMessage(err))
}

// PullRequestAction names the action that was refused, since the same
// state says different things about different actions: a conflicting PR
// explains a refused Merge or Update branch, but not a refused Close.
type PullRequestAction string

// The actions that answer a refusal with an ActionRefusal.
const (
	PullRequestActionMerge          PullRequestAction = "merge"
	PullRequestActionClose          PullRequestAction = "close"
	PullRequestActionUpdateBranch   PullRequestAction = "update_branch"
	PullRequestActionAutoMerge      PullRequestAction = "auto_merge"
	PullRequestActionDependabot     PullRequestAction = "dependabot"
	PullRequestActionRenovateRebase PullRequestAction = "renovate_rebase"
	PullRequestActionRerunChecks    PullRequestAction = "rerun_checks"
)

// ClassifyActionRefusal classifies a refused Merge; see
// ClassifyActionRefusalFor.
func ClassifyActionRefusal(actionErr error, state *PullRequestState) ActionRefusal {
	return ClassifyActionRefusalFor(PullRequestActionMerge, actionErr, state)
}

// ClassifyActionRefusalFor maps a refused action plus a re-read of the pull
// request's state onto the shared code set. state is nil when it wasn't
// (or couldn't be) read; the result is then ActionUnknown carrying the
// forge's own message, except for refusals that need no re-read: a
// permission or rate-limit refusal says all there is to say by itself, and
// so does an Update branch conflict or an auto-merge refusal whose forge
// text names the reason.
func ClassifyActionRefusalFor(action PullRequestAction, actionErr error, state *PullRequestState) ActionRefusal {
	// A rate limit comes first: it needs no re-read, and a re-read under it
	// would be limited too.
	if r, ok := refusalFromKind(actionErr); ok && r.Code == ActionRateLimited {
		return r
	}
	// A pull request already merged or closed comes before a permission
	// refusal (#904): the forge refuses that call with a 403 as well, and
	// "check your token" would send the user the wrong way.
	if r, ok := refusalFromFinishedState(state); ok {
		return r
	}
	if r, ok := refusalFromWorkflowChange(action, actionErr, state); ok {
		return r
	}
	if r, ok := refusalFromKind(actionErr); ok {
		return r
	}

	forgeText := ForgeMessage(actionErr)
	switch action {
	case PullRequestActionMerge:
		if state != nil {
			return classifyMergeRefusal(forgeText, state)
		}
	case PullRequestActionUpdateBranch:
		return classifyUpdateBranchRefusal(actionErr, forgeText, state)
	case PullRequestActionAutoMerge:
		return classifyAutoMergeRefusal(actionErr, forgeText)
	case PullRequestActionRenovateRebase:
		if clientErr, ok := errors.AsType[*ClientError](actionErr); ok && clientErr.Kind == ForgeErrorNotFound && state != nil {
			// The pull request itself was just re-read, so what's missing is
			// the label: Forgejo takes an existing label's ID.
			return ActionRefusal{Code: ActionLabelMissing, Message: "The rebase label doesn't exist on this repo. Create it there first."}
		}
	case PullRequestActionClose, PullRequestActionDependabot, PullRequestActionRerunChecks:
	}

	return unknownRefusal(actionErr, forgeText)
}

const (
	noReasonMessage     = "The forge refused this action and gave no reason."
	unreachableMessage  = "The forge didn't answer. Try again in a moment."
	maxPlainMessageSize = 200
)

// unknownRefusal is the answer when no code fits. Its message is shown to a
// person (#796), so it is the forge's own sentence when that reads as one,
// and a fixed plain sentence otherwise: never an internal prefix, an API
// path, a URL or JSON. The raw text stays in the error, for the server log.
func unknownRefusal(actionErr error, forgeText string) ActionRefusal {
	if clientErr, ok := errors.AsType[*ClientError](actionErr); ok {
		if clientErr.Kind == ForgeErrorUnreachable {
			return ActionRefusal{Code: ActionUnknown, Message: unreachableMessage}
		}
		if isPlainSentence(forgeText) {
			return ActionRefusal{Code: ActionUnknown, Message: forgeText}
		}
	}

	return ActionRefusal{Code: ActionUnknown, Message: noReasonMessage}
}

// isPlainSentence reports whether text reads as words for a person: not
// empty, short, opening with a letter, and free of the marks that give away an API path, a URL or
// a JSON body.
func isPlainSentence(text string) bool {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > maxPlainMessageSize {
		return false
	}

	// A status line such as "422 unprocessable" or "[Body]: x" isn't a
	// sentence either, so it has to open with a letter.
	if first, _ := utf8.DecodeRuneInString(text); !unicode.IsLetter(first) {
		return false
	}

	// What ForgeMessage couldn't strip: an internal prefix with nothing
	// after it.
	lower := strings.ToLower(text)
	for _, prefix := range []string{"dashboard:", "forgejo:", "github:"} {
		if strings.HasPrefix(lower, prefix) {
			return false
		}
	}

	return !strings.ContainsAny(text, "/{}") && !strings.Contains(text, "://")
}

// refusalFromWorkflowChange explains a permission refusal of Update branch on
// a pull request that changes workflow files: the cause is the app's missing
// Workflows permission, which a token in Settings can't fix (#919).
func refusalFromWorkflowChange(action PullRequestAction, actionErr error, state *PullRequestState) (ActionRefusal, bool) {
	if action != PullRequestActionUpdateBranch || state == nil || !state.ChangesWorkflows {
		return ActionRefusal{}, false
	}
	if clientErr, ok := errors.AsType[*ClientError](actionErr); !ok || clientErr.Kind != ForgeErrorUnauthorized {
		return ActionRefusal{}, false
	}

	return ActionRefusal{Code: ActionPermission, Message: "GitHub won't let this app update a branch that changes workflow files. The app needs the Workflows permission, or update the branch by hand."}, true
}

// refusalFromKind is the part every action shares that the forge's error
// kind alone decides, with no re-read.
func refusalFromKind(actionErr error) (ActionRefusal, bool) {
	clientErr, ok := errors.AsType[*ClientError](actionErr)
	if !ok {
		return ActionRefusal{}, false
	}
	switch clientErr.Kind {
	case ForgeErrorRateLimited:
		r := ActionRefusal{Code: ActionRateLimited, Message: "The forge's API rate limit is reached. Try again once it resets."}
		if clientErr.RateLimit != nil && !clientErr.RateLimit.ResetsAt.IsZero() {
			at := clientErr.RateLimit.ResetsAt
			r.ResetsAt = &at
		}

		return r, true
	case ForgeErrorUnauthorized:
		return ActionRefusal{Code: ActionPermission, Message: "Missing permission — check your token in Settings."}, true
	}

	return ActionRefusal{}, false
}

func classifyMergeRefusal(forgeText string, state *PullRequestState) ActionRefusal {
	if r, ok := refusalFromFlags(state); ok {
		return r
	}

	lower := strings.ToLower(forgeText)
	if strings.Contains(lower, "approval") || strings.Contains(lower, "requested change") {
		return ActionRefusal{Code: ActionBlockedByProtection, Message: "Blocked by branch protection: a required review is missing."}
	}
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

// classifyUpdateBranchRefusal reads the forge's own answer: GitHub says
// 422 for a conflict (mapped to ForgeErrorConflict by the client, #702) and
// Forgejo says 409. "Nothing new on the base" is checked first because it
// is a 422 too.
func classifyUpdateBranchRefusal(actionErr error, forgeText string, state *PullRequestState) ActionRefusal {
	lower := strings.ToLower(forgeText)
	if strings.Contains(lower, "no new commits") || strings.Contains(lower, "up to date") || strings.Contains(lower, "up-to-date") {
		return ActionRefusal{Code: ActionAlreadyUpToDate, Message: "The branch is already up to date with its base."}
	}
	conflictKind := false
	if clientErr, ok := errors.AsType[*ClientError](actionErr); ok {
		conflictKind = clientErr.Kind == ForgeErrorConflict
	}
	if conflictKind || (state != nil && state.Conflicting) {
		return ActionRefusal{Code: ActionConflict, Message: "Can't update cleanly. Resolve the conflict on the forge."}
	}

	return unknownRefusal(actionErr, forgeText)
}

// classifyAutoMergeRefusal reads the messages GitHub's
// enablePullRequestAutoMerge mutation answers with; it has no status or
// error type of its own to go by.
func classifyAutoMergeRefusal(actionErr error, forgeText string) ActionRefusal {
	lower := strings.ToLower(forgeText)
	switch {
	case strings.Contains(lower, "auto merge is not allowed") || strings.Contains(lower, "auto-merge is not allowed"):
		return ActionRefusal{Code: ActionAutoMergeNotAllowed, Message: "Auto-merge isn't allowed for this pull request. Turn it on in the repo's settings."}
	case strings.Contains(lower, "is in clean status"):
		return ActionRefusal{Code: ActionReadyToMerge, Message: "This pull request is already ready to merge, so there's nothing for auto-merge to wait for. Use Merge instead."}
	case strings.Contains(lower, "is in unstable status"):
		return ActionRefusal{Code: ActionChecksPending, Message: "GitHub reports this pull request as unstable: a non-required check is still running or has failed. Try again once it settles."}
	case strings.Contains(lower, "protected branch rules not configured"):
		return ActionRefusal{Code: ActionBlockedByProtection, Message: "Auto-merge needs a branch protection rule with a required check or review on the base branch."}
	}

	return unknownRefusal(actionErr, forgeText)
}

// refusalFromFlags is the part of the classification the re-read alone
// decides, without the forge's own text.
func refusalFromFlags(state *PullRequestState) (ActionRefusal, bool) {
	switch {
	case state.Conflicting:
		return ActionRefusal{Code: ActionConflict, Message: "Merge conflict. Resolve it on the forge, then merge."}, true
	case state.ConflictUnconfirmed:
		return ActionRefusal{Code: ActionConflict, Message: "Probably a merge conflict: the forge says this isn't mergeable but not why, and says the same while it is still checking. Refresh in a moment; if it stays, resolve the conflict on the forge."}, true
	case state.Behind:
		return ActionRefusal{Code: ActionBehind, Message: "Behind the base branch. Bring it up to date, then merge."}, true
	case state.Draft:
		return ActionRefusal{Code: ActionNotMergeable, Message: "Draft pull request. Mark it ready for review to merge."}, true
	case state.ChecksFailing:
		return ActionRefusal{Code: ActionChecksFailing, Message: "A check is failing. Fix it, then merge."}, true
	}

	return ActionRefusal{}, false
}

// refusalFromFinishedState is the answer for a pull request found already
// merged or closed, whatever the forge's own refusal said. False when state
// is nil (no re-read) or the pull request is still open.
func refusalFromFinishedState(state *PullRequestState) (ActionRefusal, bool) {
	switch {
	case state == nil:
		return ActionRefusal{}, false
	case state.Merged:
		return ActionRefusal{Code: ActionAlreadyMerged, Message: "This pull request was already merged."}, true
	case state.Closed:
		return ActionRefusal{Code: ActionAlreadyClosed, Message: "This pull request was closed without merging."}, true
	}

	return ActionRefusal{}, false
}
