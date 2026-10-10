package dashboard

import (
	"context"
	"regexp"
)

// PullRequestBodyEditor is implemented by a Source that can read and replace
// the description of one of its own pull requests — checked via a type
// assertion, like PullRequestLabeler. Renovate's rebase checkbox lives in
// that description.
type PullRequestBodyEditor interface {
	PullRequestBody(ctx context.Context, owner, name string, number int) (string, error)
	SetPullRequestBody(ctx context.Context, owner, name string, number int, body string) error
}

// RebaseCheckbox is what a pull request body says about Renovate's
// `rebase-check` checkbox.
type RebaseCheckbox int

const (
	// RebaseCheckboxAbsent means the body has no rebase-check line.
	RebaseCheckboxAbsent RebaseCheckbox = iota
	// RebaseCheckboxUnticked means the box is there and unchecked.
	RebaseCheckboxUnticked
	// RebaseCheckboxTicked means the box is already checked, so a rebase is queued.
	RebaseCheckboxTicked
)

// rebaseCheckRe matches the box mark of Renovate's line
// `- [ ] <!-- rebase-check -->If you want to rebase/retry this PR, ...`.
var rebaseCheckRe = regexp.MustCompile(`\[([ xX])\](\s*<!-- rebase-check -->)`)

// TickRebaseCheckbox checks Renovate's rebase-check box in body. It returns
// the new body, changed in that one character only, and what the body held
// before. A body with the box already checked or missing comes back as is.
func TickRebaseCheckbox(body string) (string, RebaseCheckbox) {
	loc := rebaseCheckRe.FindStringSubmatchIndex(body)
	if loc == nil {
		return body, RebaseCheckboxAbsent
	}
	if body[loc[2]] != ' ' {
		return body, RebaseCheckboxTicked
	}

	return body[:loc[2]] + "x" + body[loc[2]+1:], RebaseCheckboxUnticked
}

// RenovateRebaseOutcome is how a Renovate rebase request was made.
type RenovateRebaseOutcome int

const (
	// RenovateRebaseTicked means the body's checkbox was checked.
	RenovateRebaseTicked RenovateRebaseOutcome = iota
	// RenovateRebaseLabeled means there was no checkbox, so the label was added.
	RenovateRebaseLabeled
	// RenovateRebaseAlreadyRequested means the box was already checked.
	RenovateRebaseAlreadyRequested
)

// RequestRenovateRebase asks Renovate to rebase owner/name#number. It checks
// the rebase-check box in the pull request body, which needs no setup on the
// repo, and falls back to adding label when src can't edit the body or the
// body has no such box. Forge errors come back unwrapped: the API handler
// shows their text to the person, and the client already says where it came
// from.
func RequestRenovateRebase(ctx context.Context, src any, labeler PullRequestLabeler, owner, name string, number int, label string) (RenovateRebaseOutcome, error) {
	if editor, ok := src.(PullRequestBodyEditor); ok {
		body, err := editor.PullRequestBody(ctx, owner, name, number)
		if err != nil {
			return RenovateRebaseTicked, err //nolint:wrapcheck // see the doc comment
		}
		ticked, state := TickRebaseCheckbox(body)
		switch state {
		case RebaseCheckboxTicked:
			return RenovateRebaseAlreadyRequested, nil
		case RebaseCheckboxUnticked:
			return RenovateRebaseTicked, editor.SetPullRequestBody(ctx, owner, name, number, ticked) //nolint:wrapcheck // see the doc comment
		case RebaseCheckboxAbsent:
		}
	}

	return RenovateRebaseLabeled, labeler.AddLabel(ctx, owner, name, number, label) //nolint:wrapcheck // see the doc comment
}
