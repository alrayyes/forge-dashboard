package dashboard

import "context"

// ImageItemKind says which GitHub object an embedded image belongs to.
type ImageItemKind string

const (
	// ImageItemIssue is an issue or a pull request: GitHub serves both from
	// the issues route.
	ImageItemIssue ImageItemKind = "issue"
	// ImageItemRelease is a release, found by its tag.
	ImageItemRelease ImageItemKind = "release"
)

// ImageItem names the issue, pull request or release whose text embeds an image.
type ImageItem struct {
	Kind   ImageItemKind
	Number int    // for ImageItemIssue
	Tag    string // for ImageItemRelease
}

// ImageLinkResolver is implemented by a Source that can turn an attachment
// link in an item's text into the address its host will serve to this
// account. A private repository's attachment link returns 404 on its own; the
// item's rendered HTML carries a signed address for it (#3469).
type ImageLinkResolver interface {
	// SignedImageURL returns the address the item's rendered HTML uses for
	// link, or an empty string when the item doesn't embed it.
	SignedImageURL(ctx context.Context, owner, name string, item ImageItem, link string) (string, error)
}
