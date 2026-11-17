package dashboard

import "context"

// IssueState is whether the forge has the issue open or closed right now.
type IssueState string

const (
	// IssueStateOpen is an issue the forge has open.
	IssueStateOpen IssueState = "open"
	// IssueStateClosed is an issue the forge has closed.
	IssueStateClosed IssueState = "closed"
)

// ItemKind says what a number turned out to be. A forge shares one number
// space between issues and pull requests, so a reference to #12 can be either.
type ItemKind string

const (
	// ItemKindIssue is an issue.
	ItemKindIssue ItemKind = "issue"
	// ItemKindPullRequest is a pull request.
	ItemKindPullRequest ItemKind = "pullRequest"
)

// ReferencedState is where a pull request stands on its forge. IssueState
// folds merged into closed, which an issue's dialog is happy with; a pull
// request's header says which.
type ReferencedState string

const (
	// ReferencedStateOpen is a pull request the forge has open.
	ReferencedStateOpen ReferencedState = "open"
	// ReferencedStateClosed is a pull request closed without merging.
	ReferencedStateClosed ReferencedState = "closed"
	// ReferencedStateMerged is a pull request that was merged.
	ReferencedStateMerged ReferencedState = "merged"
)

// IssuePullRequest is what a pull request opened from a bare number needs for
// its header, when the board has no row for it. Matches
// components.schemas.IssuePullRequest.
type IssuePullRequest struct {
	Title string          `json:"title"`
	State ReferencedState `json:"state"`
	// Author is nil for a deleted account.
	Author *Person `json:"author"`
}

// IssueDetails is what the issue dialog shows: the description and the
// conversation, read the way a pull request's are. Matches
// components.schemas.IssueDetails.
type IssueDetails struct {
	Kind  ItemKind   `json:"kind"`
	State IssueState `json:"state"`
	// PullRequest is set only when Kind is pullRequest.
	PullRequest       *IssuePullRequest `json:"pullRequest,omitempty"`
	Description       DetailsBody       `json:"description"`
	Comments          []DetailsComment  `json:"comments"`
	CommentCount      int               `json:"commentCount"`
	CommentsTruncated bool              `json:"commentsTruncated"`
}

// IssueDetailer is implemented by a Source that can read one of its own
// issues' description, comments and reactions on demand, the sibling of
// PullRequestDetailer and never part of a refresh for the same reason: the
// dialog is the only reader.
type IssueDetailer interface {
	GetIssueDetails(ctx context.Context, owner, name string, number int) (IssueDetails, error)
}
