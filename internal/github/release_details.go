package github

import (
	"context"
	"errors"
	"fmt"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// releaseDetailsQuery reads what the release dialog shows in one request: the
// published release's title, notes and thumbs reactions, with the same caps as
// the pull request dialog (dashboard.MaxReactionLogins).
const releaseDetailsQuery = `
query($owner: String!, $name: String!, $tag: String!) {
  repository(owner: $owner, name: $name) {
    release(tagName: $tag) {
      tagName
      name
      url
      publishedAt
      description
      isDraft
      isPrerelease
      reactionGroups { content users(first: 10) { totalCount nodes { login } } }
    }
  }
}`

var errReleaseNotFound = errors.New("github: release not found")

type releaseDetailsResponse struct {
	Repository struct {
		Release *struct {
			TagName        string                 `json:"tagName"`
			Name           string                 `json:"name"`
			URL            string                 `json:"url"`
			PublishedAt    *string                `json:"publishedAt"`
			Description    string                 `json:"description"`
			IsDraft        bool                   `json:"isDraft"`
			IsPrerelease   bool                   `json:"isPrerelease"`
			ReactionGroups []graphqlReactionGroup `json:"reactionGroups"`
		} `json:"release"`
	} `json:"repository"`
}

// GetReleaseDetails implements dashboard.ReleaseDetailer: one GraphQL query for
// owner/name's published release at tag.
func (c *Client) GetReleaseDetails(ctx context.Context, owner, name, tag string) (dashboard.ReleaseDetails, error) {
	var resp releaseDetailsResponse
	vars := map[string]any{"owner": owner, "name": name, "tag": tag}
	if err := c.graphqlDo(ctx, releaseDetailsQuery, vars, &resp); err != nil {
		return dashboard.ReleaseDetails{}, asClientError(err)
	}

	release := resp.Repository.Release
	// A draft, a pre-release and a release with no publish date are not
	// published as far as the board goes (it lists none of them), so each is
	// not found.
	if release == nil || release.IsDraft || release.IsPrerelease || release.PublishedAt == nil {
		return dashboard.ReleaseDetails{}, &dashboard.ClientError{
			Kind: dashboard.ForgeErrorNotFound,
			Err:  fmt.Errorf("%w: %s/%s@%s", errReleaseNotFound, owner, name, tag),
		}
	}

	text, truncated := dashboard.CapText(release.Description, dashboard.MaxDetailsBodyRunes)
	details := dashboard.ReleaseDetails{
		Tag: release.TagName, Name: release.Name, URL: release.URL,
		PublishedAt: *release.PublishedAt,
		Notes: dashboard.DetailsBody{
			Text: text, Format: dashboard.FormatMarkdown, Truncated: truncated,
			Reactions: reactionsOf(release.ReactionGroups),
		},
	}

	return details, nil
}
