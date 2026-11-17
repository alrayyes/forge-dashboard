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

// IssueDetails is what the issue dialog shows: the description and the
// conversation, read the way a pull request's are. Matches
// components.schemas.IssueDetails.
type IssueDetails struct {
	Kind              ItemKind         `json:"kind"`
	State             IssueState       `json:"state"`
	Description       DetailsBody      `json:"description"`
	Comments          []DetailsComment `json:"comments"`
	CommentCount      int              `json:"commentCount"`
	CommentsTruncated bool             `json:"commentsTruncated"`
}

// IssueDetailer is implemented by a Source that can read one of its own
// issues' description, comments and reactions on demand, the sibling of
// PullRequestDetailer and never part of a refresh for the same reason: the
// dialog is the only reader.
type IssueDetailer interface {
	GetIssueDetails(ctx context.Context, owner, name string, number int) (IssueDetails, error)
}
