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
  title
  url
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
  timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 100) {
    nodes {
      ... on CrossReferencedEvent {
        willCloseTarget
        source {
          __typename
          ... on Issue { number title url body state repository { nameWithOwner } }
          ... on PullRequest { number title url body state repository { nameWithOwner } }
        }
      }
    }
  }
}

fragment pullRequestThread on PullRequest {
  state
  title
  url
  author { login avatarUrl }
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
  timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 100) {
    nodes {
      ... on CrossReferencedEvent {
        willCloseTarget
        source {
          __typename
          ... on Issue { number title url body state repository { nameWithOwner } }
          ... on PullRequest { number title url body state repository { nameWithOwner } }
        }
      }
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
			Typename string                `json:"__typename"`
			Title    string                `json:"title"`
			URL      string                `json:"url"`
			Author   *graphqlDetailsAuthor `json:"author"`
			graphqlDetailsThread
			TimelineItems struct {
				Nodes []crossReferenceNode `json:"nodes"`
			} `json:"timelineItems"`
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
	fullName := owner + "/" + name
	base := dashboard.WebBase(item.URL, fullName)
	if base == "" {
		base = "https://github.com"
	}
	details.References = dashboard.ClassifyIncoming(incomingReferences(item.TimelineItems.Nodes), dashboard.ForgeGitHub, fullName, number, base)
	if item.Typename == "PullRequest" {
		details.Kind = dashboard.ItemKindPullRequest
		details.PullRequest = &dashboard.IssuePullRequest{Title: item.Title, State: pullRequestStateOf(item.State)}
		if item.Author != nil {
			details.PullRequest.Author = &dashboard.Person{Login: item.Author.Login, AvatarURL: item.Author.AvatarURL}
		}
	}
	details.State = dashboard.IssueStateOpen
	if item.State == "CLOSED" || item.State == "MERGED" {
		details.State = dashboard.IssueStateClosed
	}

	details.References = append(details.References, c.outgoingReferences(ctx, details.Kind, item.Title, item.URL, item.Body, owner, name, number)...)

	return details, nil
}

func pullRequestStateOf(state string) dashboard.ReferencedState {
	switch state {
	case "MERGED":
		return dashboard.ReferencedStateMerged
	case "CLOSED":
		return dashboard.ReferencedStateClosed
	default:
		return dashboard.ReferencedStateOpen
	}
}

// crossReferenceNode is one CROSS_REFERENCED_EVENT of an item's timeline: an
// issue or pull request that names it. A node of another type comes back
// empty.
type crossReferenceNode struct {
	WillCloseTarget bool `json:"willCloseTarget"`
	Source          *struct {
		Typename   string `json:"__typename"`
		Number     int    `json:"number"`
		Title      string `json:"title"`
		URL        string `json:"url"`
		Body       string `json:"body"`
		State      string `json:"state"`
		Repository struct {
			NameWithOwner string `json:"nameWithOwner"`
		} `json:"repository"`
	} `json:"source"`
}

// incomingReferences turns the timeline's cross references into the items that
// refer to this one. GitHub's timeline does not tell a reference from a
// mention, so every one that does not close is a mention.
func incomingReferences(nodes []crossReferenceNode) []dashboard.ItemReference {
	var refs []dashboard.ItemReference
	for _, node := range nodes {
		src := node.Source
		if src == nil || src.Number == 0 {
			continue
		}
		relation := dashboard.RelationMentions
		if node.WillCloseTarget {
			relation = dashboard.RelationCloses
		}
		ref := dashboard.ItemReference{
			Forge: dashboard.ForgeGitHub, Repo: src.Repository.NameWithOwner, Number: src.Number,
			Title: src.Title, URL: src.URL, Body: src.Body, Kind: dashboard.ItemKindIssue,
			State: pullRequestStateOf(src.State), Direction: dashboard.ReferenceIncoming, Relation: relation,
		}
		if src.Typename == "PullRequest" {
			ref.Kind = dashboard.ItemKindPullRequest
		}
		refs = append(refs, ref)
	}

	return dashboard.NewestFirstReferences(refs)
}
