package github

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
)

const (
	// dependabotLogin is the account Dependabot reacts as.
	dependabotLogin = "dependabot[bot]"
	// ackClockSlack is how far before the request a comment may be dated and
	// still be its comment: this app records the request after posting, and
	// GitHub dates comments to the second.
	ackClockSlack = time.Minute
)

// DependabotAck implements dashboard.DependabotAckReader: finds the newest
// comment on owner/name#number whose text is exactly command and that was
// posted at or after since (less ackClockSlack), and reports whether Dependabot has reacted to it
// with a thumbs-up, which is how it says it got the command (#1082,
// https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/manage-dependabot-prs).
// With no such comment it returns the zero CommandAck.
func (c *Client) DependabotAck(ctx context.Context, owner, name string, number int, command string, since time.Time) (dashboard.CommandAck, error) {
	comment, err := c.newestCommandComment(ctx, owner, name, number, command, since)
	if err != nil || comment == nil {
		return dashboard.CommandAck{}, err
	}

	ack := dashboard.CommandAck{CommentURL: comment.GetHTMLURL()}
	path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d/reactions", owner, name, comment.GetID())
	opts := &ghsdk.ListReactionOptions{PerPage: 100}
	for {
		slog.Debug("github request", "method", http.MethodGet, "url", path)
		reactions, resp, err := c.restClient.Reactions.ListIssueCommentReactions(ctx, owner, name, comment.GetID(), opts)
		if err != nil {
			return dashboard.CommandAck{}, asClientError(c.restError(ctx, http.MethodGet, path, err))
		}
		c.recordRESTSuccess(ctx, http.MethodGet, path, resp)
		for _, r := range reactions {
			if r.GetContent() == "+1" && r.GetUser().GetLogin() == dependabotLogin {
				ack.Acknowledged = true

				return ack, nil
			}
		}
		if resp.NextPage == 0 {
			return ack, nil
		}
		opts.Page = resp.NextPage
	}
}

// newestCommandComment pages through the pull request's comments for the
// latest one that is exactly command and not older than since.
func (c *Client) newestCommandComment(ctx context.Context, owner, name string, number int, command string, since time.Time) (*ghsdk.IssueComment, error) {
	path := fmt.Sprintf("/repos/%s/%s/issues/%d/comments", owner, name, number)
	opts := &ghsdk.IssueListCommentsOptions{PerPage: 100}

	var newest *ghsdk.IssueComment
	for {
		slog.Debug("github request", "method", http.MethodGet, "url", path)
		comments, resp, err := c.restClient.Issues.ListComments(ctx, owner, name, number, opts)
		if err != nil {
			return nil, asClientError(c.restError(ctx, http.MethodGet, path, err))
		}
		c.recordRESTSuccess(ctx, http.MethodGet, path, resp)
		for _, cm := range comments {
			if cm.GetBody() != command || cm.GetCreatedAt().Before(since.Add(-ackClockSlack)) {
				continue
			}
			if newest == nil || cm.GetCreatedAt().After(newest.GetCreatedAt().Time) {
				newest = cm
			}
		}
		if resp.NextPage == 0 {
			return newest, nil
		}
		opts.Page = resp.NextPage
	}
}
