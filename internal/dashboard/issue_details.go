package dashboard

import (
	"context"
	"strconv"
)

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

// ReferenceDirection says which way a reference points, seen from the item
// whose details were asked for.
type ReferenceDirection string

const (
	// ReferenceIncoming is another item that refers to this one.
	ReferenceIncoming ReferenceDirection = "incoming"
	// ReferenceOutgoing is an item this one refers to. The contract has it so a
	// later read can add it without another change; no forge read returns it yet.
	ReferenceOutgoing ReferenceDirection = "outgoing"
)

// ReferenceRelation is what the referring item does to the referred-to one.
type ReferenceRelation string

const (
	// RelationCloses closes the item when it merges.
	RelationCloses ReferenceRelation = "closes"
	// RelationRefs references the item without closing it.
	RelationRefs ReferenceRelation = "refs"
	// RelationMentions names the item. A forge's timeline can't tell it from
	// refs, so a read from one says mentions for both.
	RelationMentions ReferenceRelation = "mentions"
)

// ItemReference is one issue or pull request related to the item whose details
// were asked for. Matches components.schemas.ItemReference. PageURL is set by
// the API from Forge, Repo, Number and Kind, not by a forge client.
type ItemReference struct {
	Forge     Forge              `json:"forge"`
	Repo      string             `json:"repo"`
	Number    int                `json:"number"`
	Title     string             `json:"title"`
	URL       string             `json:"url"`
	PageURL   string             `json:"pageUrl"`
	Kind      ItemKind           `json:"kind"`
	State     ReferencedState    `json:"state"`
	Direction ReferenceDirection `json:"direction"`
	Relation  ReferenceRelation  `json:"relation"`
}

// ReferencePageURL is the address on this dashboard that opens the referenced
// item's pop-up: its pull request page or the Issues page.
func ReferencePageURL(ref ItemReference) string {
	if ref.Kind == ItemKindPullRequest {
		return "/pull-requests.html?pr=" + string(ref.Forge) + "/" + ref.Repo + "/" + strconv.Itoa(ref.Number)
	}

	return IssuePageURL(ref.Forge, ref.Repo, ref.Number)
}

// MaxReferences caps the references one read returns.
const MaxReferences = 50

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
	// References are the items that refer to this one, newest first. Never nil
	// once the API has answered.
	References []ItemReference `json:"references"`
}

// IssueDetailer is implemented by a Source that can read one of its own
// issues' description, comments and reactions on demand, the sibling of
// PullRequestDetailer and never part of a refresh for the same reason: the
// dialog is the only reader.
type IssueDetailer interface {
	GetIssueDetails(ctx context.Context, owner, name string, number int) (IssueDetails, error)
}
