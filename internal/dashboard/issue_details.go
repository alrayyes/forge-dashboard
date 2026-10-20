package dashboard

import "context"

// IssueDetails is what the issue dialog shows: the description and the
// conversation, read the way a pull request's are. Matches
// components.schemas.IssueDetails.
type IssueDetails struct {
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
