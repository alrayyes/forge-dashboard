package github

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"regexp"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// renderedMediaType asks the REST API for the item's body as HTML too. In a
// private repository that HTML points each attachment at a signed
// private-user-images address, which the bare attachment link is not (#3469).
const renderedMediaType = "application/vnd.github.full+json"

// renderedAnchor matches an attachment's link and the image inside it, the
// shape GitHub renders a pasted screenshot as.
var renderedAnchor = regexp.MustCompile(`(?s)<a\b[^>]*?\bhref="([^"]*)"[^>]*>\s*<img\b[^>]*?\bsrc="([^"]*)"`)

var errImageItemKind = errors.New("github: unknown image item kind")

type renderedBody struct {
	BodyHTML string `json:"body_html"`
}

// SignedImageURL implements dashboard.ImageLinkResolver: the address owner/name's
// issue, pull request or release uses for the attachment at link. The token
// goes to the API host only; the caller fetches the result without it.
func (c *Client) SignedImageURL(ctx context.Context, owner, name string, item dashboard.ImageItem, link string) (string, error) {
	path := "repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
	switch item.Kind {
	case dashboard.ImageItemIssue:
		path += fmt.Sprintf("/issues/%d", item.Number)
	case dashboard.ImageItemRelease:
		path += "/releases/tags/" + url.PathEscape(item.Tag)
	default:
		return "", fmt.Errorf("%w: %q", errImageItemKind, item.Kind)
	}
	req, err := c.restClient.NewRequest(http.MethodGet, path, nil)
	if err != nil {
		return "", fmt.Errorf("read rendered body: %w", err)
	}
	req.Header.Set("Accept", renderedMediaType)
	var body renderedBody
	resp, err := c.restClient.Do(ctx, req, &body)
	if err != nil {
		return "", asClientError(c.restError(ctx, http.MethodGet, "/"+path, err))
	}
	c.recordRESTSuccess(ctx, http.MethodGet, "/"+path, resp)

	for _, m := range renderedAnchor.FindAllStringSubmatch(body.BodyHTML, -1) {
		if html.UnescapeString(m[1]) == link {
			return html.UnescapeString(m[2]), nil
		}
	}

	return "", nil
}
