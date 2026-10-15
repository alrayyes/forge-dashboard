package github

import (
	"context"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// pullRequestDetailsQuery reads everything the pull request dialog shows in one
// request (#1506): the description, the first comments and the reaction groups
// on each, with the first few people behind each reaction. The caps in the query
// are the contract's (dashboard.MaxDetailsComments, MaxReactionLogins), so a
// response can't outgrow them.
const pullRequestDetailsQuery = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
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

type graphqlReactionGroup struct {
	Content string `json:"content"`
	Users   struct {
		TotalCount int `json:"totalCount"`
		Nodes      []struct {
			Login string `json:"login"`
		} `json:"nodes"`
	} `json:"users"`
}

type graphqlDetailsAuthor struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
}

type pullRequestDetailsResponse struct {
	Repository struct {
		PullRequest struct {
			Body           string                 `json:"body"`
			LastEditedAt   *string                `json:"lastEditedAt"`
			ReactionGroups []graphqlReactionGroup `json:"reactionGroups"`
			Comments       struct {
				TotalCount int `json:"totalCount"`
				Nodes      []struct {
					ID             string                 `json:"id"`
					CreatedAt      string                 `json:"createdAt"`
					LastEditedAt   *string                `json:"lastEditedAt"`
					Body           string                 `json:"body"`
					Author         *graphqlDetailsAuthor  `json:"author"`
					ReactionGroups []graphqlReactionGroup `json:"reactionGroups"`
				} `json:"nodes"`
			} `json:"comments"`
		} `json:"pullRequest"`
	} `json:"repository"`
}

// GetPullRequestDetails implements dashboard.PullRequestDetailer: one GraphQL
// query for owner/name#number's description, comments and thumbs reactions.
func (c *Client) GetPullRequestDetails(ctx context.Context, owner, name string, number int) (dashboard.PullRequestDetails, error) {
	var resp pullRequestDetailsResponse
	vars := map[string]any{"owner": owner, "name": name, "number": number}
	if err := c.graphqlDo(ctx, pullRequestDetailsQuery, vars, &resp); err != nil {
		return dashboard.PullRequestDetails{}, asClientError(err)
	}
	pr := resp.Repository.PullRequest

	text, truncated := dashboard.CapText(pr.Body, dashboard.MaxDetailsBodyRunes)
	details := dashboard.PullRequestDetails{
		Description: dashboard.DetailsBody{
			Text: text, Format: dashboard.FormatMarkdown, Truncated: truncated,
			Edited: pr.LastEditedAt != nil, Reactions: reactionsOf(pr.ReactionGroups),
		},
		Comments:     []dashboard.DetailsComment{},
		CommentCount: pr.Comments.TotalCount,
	}
	for _, node := range pr.Comments.Nodes {
		if len(details.Comments) == dashboard.MaxDetailsComments {
			break
		}
		commentText, commentTruncated := dashboard.CapText(node.Body, dashboard.MaxDetailsBodyRunes)
		comment := dashboard.DetailsComment{
			ID: node.ID, CreatedAt: node.CreatedAt, UpdatedAt: node.LastEditedAt, Edited: node.LastEditedAt != nil,
			Text: commentText, Format: dashboard.FormatMarkdown, Truncated: commentTruncated,
			Reactions: reactionsOf(node.ReactionGroups),
		}
		if node.Author != nil {
			comment.Author = &dashboard.Person{Login: node.Author.Login, AvatarURL: node.Author.AvatarURL}
		}
		details.Comments = append(details.Comments, comment)
	}
	details.CommentsTruncated = details.CommentCount > len(details.Comments)

	return details, nil
}

// reactionsOf keeps the two reactions the dialog shows. A content with no
// group is a count of zero and an empty array, never missing.
func reactionsOf(groups []graphqlReactionGroup) dashboard.Reactions {
	reactions := dashboard.Reactions{
		ThumbsUp:   dashboard.Reaction{Logins: []string{}},
		ThumbsDown: dashboard.Reaction{Logins: []string{}},
	}
	for _, g := range groups {
		var logins []string
		for _, n := range g.Users.Nodes {
			logins = append(logins, n.Login)
		}
		reaction := dashboard.Reaction{Count: g.Users.TotalCount, Logins: dashboard.CapLogins(logins)}
		switch g.Content {
		case "THUMBS_UP":
			reactions.ThumbsUp = reaction
		case "THUMBS_DOWN":
			reactions.ThumbsDown = reaction
		}
	}

	return reactions
}
