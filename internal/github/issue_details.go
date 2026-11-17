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
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { ...issueThread }
      ... on PullRequest { ...pullRequestThread }
    }
  }
}

fragment issueThread on Issue {
  state
  body
  lastEditedAt
  reactionGroups { content users(first: 10) { totalCount nodes { login } } }
  comments(first: 50) {
    totalCount
    nodes {
      databaseId
      createdAt
      lastEditedAt
      body
      author { login avatarUrl }
      reactionGroups { content users(first: 10) { totalCount nodes { login } } }
    }
  }
}

fragment pullRequestThread on PullRequest {
  state
  body
  lastEditedAt
  reactionGroups { content users(first: 10) { totalCount nodes { login } } }
  comments(first: 50) {
    totalCount
    nodes {
      databaseId
      createdAt
      lastEditedAt
      body
      author { login avatarUrl }
      reactionGroups { content users(first: 10) { totalCount nodes { login } } }
    }
  }
}`

var errIssueNotFound = errors.New("github: issue or pull request not found")

func notFoundIssue(owner, name string, number int) error {
	return &dashboard.ClientError{
		Kind: dashboard.ForgeErrorNotFound,
		Err:  fmt.Errorf("%w: #%d in %s/%s", errIssueNotFound, number, owner, name),
	}
}

type issueDetailsResponse struct {
	Repository struct {
		Item *struct {
			Typename string `json:"__typename"`
			graphqlDetailsThread
		} `json:"issueOrPullRequest"`
	} `json:"repository"`
}

// GetIssueDetails implements dashboard.IssueDetailer: one GraphQL query for
// owner/name#number's description, comments and thumbs reactions.
func (c *Client) GetIssueDetails(ctx context.Context, owner, name string, number int) (dashboard.IssueDetails, error) {
	var resp issueDetailsResponse
	vars := map[string]any{"owner": owner, "name": name, "number": number}
	if err := c.graphqlDo(ctx, issueDetailsQuery, vars, &resp); err != nil {
		// GitHub's own text names the GraphQL type it couldn't resolve, which
		// means nothing to a reader.
		if clientErr, ok := errors.AsType[*dashboard.ClientError](asClientError(err)); ok && clientErr.Kind == dashboard.ForgeErrorNotFound {
			return dashboard.IssueDetails{}, notFoundIssue(owner, name, number)
		}

		return dashboard.IssueDetails{}, asClientError(err)
	}

	// A null item with no error beside it is still not there.
	if resp.Repository.Item == nil {
		return dashboard.IssueDetails{}, notFoundIssue(owner, name, number)
	}

	item := resp.Repository.Item
	details := threadDetails(item.graphqlDetailsThread)
	details.Kind = dashboard.ItemKindIssue
	if item.Typename == "PullRequest" {
		details.Kind = dashboard.ItemKindPullRequest
	}
	details.State = dashboard.IssueStateOpen
	if item.State == "CLOSED" || item.State == "MERGED" {
		details.State = dashboard.IssueStateClosed
	}

	return details, nil
}
