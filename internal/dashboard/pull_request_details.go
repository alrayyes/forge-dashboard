package dashboard

import (
	"context"
	"unicode/utf8"
)

// The caps on what the pull request dialog is sent (#1506). A body longer than
// MaxDetailsBodyRunes is cut and flagged, and a thread longer than
// MaxDetailsComments keeps its first comments with CommentsTruncated set, so the
// dialog can link to the forge for the rest. MaxReactionLogins bounds who is
// named under a reaction; the count stays the full number.
const (
	MaxDetailsBodyRunes = 20000
	MaxDetailsComments  = 50
	MaxReactionLogins   = 10
)

// Person is who wrote a body or a comment. Matches components.schemas.Person.
type Person struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
}

// Reaction is how many people gave one reaction, and the first few of them.
// Count is the full number; Logins is capped at MaxReactionLogins. Matches
// components.schemas.Reaction.
type Reaction struct {
	Count  int      `json:"count"`
	Logins []string `json:"logins"`
}

// Reactions are the two reactions the dialog shows. Matches
// components.schemas.Reactions.
type Reactions struct {
	ThumbsUp   Reaction `json:"thumbsUp"`
	ThumbsDown Reaction `json:"thumbsDown"`
}

// TextFormat says how a body's text is written, so a client can render it
// safely. Only markdown today; a later format is additive.
type TextFormat string

// FormatMarkdown is the text exactly as the forge stores it. The server neither
// converts nor sanitises it: a client must render it with raw HTML disabled.
const FormatMarkdown TextFormat = "markdown"

// DetailsBody is a pull request's description or release notes. Matches
// components.schemas.DetailsBody.
type DetailsBody struct {
	Text      string     `json:"text"`
	Format    TextFormat `json:"format"`
	Truncated bool       `json:"truncated"`
	Edited    bool       `json:"edited"`
	Reactions Reactions  `json:"reactions"`
}

// DetailsComment is one comment on the pull request's conversation. Author is
// nil for a deleted account. Matches components.schemas.DetailsComment.
type DetailsComment struct {
	ID        string     `json:"id"`
	Author    *Person    `json:"author"`
	CreatedAt string     `json:"createdAt"`
	UpdatedAt *string    `json:"updatedAt"`
	Edited    bool       `json:"edited"`
	Text      string     `json:"text"`
	Format    TextFormat `json:"format"`
	Truncated bool       `json:"truncated"`
	Reactions Reactions  `json:"reactions"`
}

// PullRequestDetails is what the pull request dialog shows: the description,
// the conversation and, for a release pull request, the release notes. Matches
// components.schemas.PullRequestDetails.
type PullRequestDetails struct {
	Description       DetailsBody      `json:"description"`
	Comments          []DetailsComment `json:"comments"`
	CommentCount      int              `json:"commentCount"`
	CommentsTruncated bool             `json:"commentsTruncated"`
	ReleaseNotes      *DetailsBody     `json:"releaseNotes"`
}

// PullRequestDetailer is implemented by a Source that can read one of its own
// pull requests' description, comments and reactions on demand, the same
// optional capability as PullRequestChecker. Never part of a refresh: the
// dialog is the only reader, and a thread for every row nobody opens would
// spend the forge's budget for nothing.
type PullRequestDetailer interface {
	GetPullRequestDetails(ctx context.Context, owner, name string, number int) (PullRequestDetails, error)
}

// CapText cuts s to at most limit characters (runes, so a cut never splits one)
// and reports whether it had to.
func CapText(s string, limit int) (string, bool) {
	if utf8.RuneCountInString(s) <= limit {
		return s, false
	}
	runes := []rune(s)

	return string(runes[:limit]), true
}

// CapLogins keeps the first MaxReactionLogins of logins. It never returns nil,
// so the JSON is an array.
func CapLogins(logins []string) []string {
	if len(logins) > MaxReactionLogins {
		logins = logins[:MaxReactionLogins]
	}
	if logins == nil {
		return []string{}
	}

	return logins
}
