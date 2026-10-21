package dashboard

import "context"

// ReleaseDetails is what the release dialog shows for a published release: its
// title and notes. Matches components.schemas.ReleaseDetails.
type ReleaseDetails struct {
	Tag string `json:"tag"`
	// Name is the release's title; the forge may leave it empty, and then the
	// tag is the title.
	Name        string      `json:"name"`
	URL         string      `json:"url"`
	PublishedAt string      `json:"publishedAt"`
	Notes       DetailsBody `json:"notes"`
}

// ReleaseDetailer is implemented by a Source that can read one of its own
// published releases by tag, on demand and never part of a refresh, for the
// same reason as PullRequestDetailer.
type ReleaseDetailer interface {
	GetReleaseDetails(ctx context.Context, owner, name, tag string) (ReleaseDetails, error)
}
