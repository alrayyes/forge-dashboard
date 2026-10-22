package github

import (
	"context"
	"errors"
	"fmt"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// issueDetailsQuery reads everything the issue dialog shows in one request,
// the same selection as the pull request dialog's, so the same caps apply
// (dashboard.MaxDetailsComments, MaxReactionLogins).
const issueDetailsQuery = `
query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      state
      body
      lastEditedAt
      reactionGroups { content users(first: 10) { totalCount nodes { login } } }
      comments(first: 50) {
        totalCount
        nodes {
          id
          createdAt
          lastEditedAt
          body
          author { login avatarUrl }
          reactionGroups { content users(first: 10) { totalCount nodes { login } } }
        }
      }
    }
  }
}`

var errIssueNotFound = errors.New("github: issue not found")

type issueDetailsResponse struct {
	Repository struct {
		Issue *graphqlDetailsThread `json:"issue"`
	} `json:"repository"`
}

// GetIssueDetails implements dashboard.IssueDetailer: one GraphQL query for
// owner/name#number's description, comments and thumbs reactions.
func (c *Client) GetIssueDetails(ctx context.Context, owner, name string, number int) (dashboard.IssueDetails, error) {
	var resp issueDetailsResponse
	vars := map[string]any{"owner": owner, "name": name, "number": number}
	if err := c.graphqlDo(ctx, issueDetailsQuery, vars, &resp); err != nil {
		return dashboard.IssueDetails{}, asClientError(err)
	}

	// A null issue with no error beside it is still not there.
	if resp.Repository.Issue == nil {
		return dashboard.IssueDetails{}, &dashboard.ClientError{
			Kind: dashboard.ForgeErrorNotFound,
			Err:  fmt.Errorf("%w: %s/%s#%d", errIssueNotFound, owner, name, number),
		}
	}

	details := threadDetails(*resp.Repository.Issue)
	details.State = dashboard.IssueStateOpen
	if resp.Repository.Issue.State == "CLOSED" {
		details.State = dashboard.IssueStateClosed
	}

	return details, nil
}
