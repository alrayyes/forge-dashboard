package forgejo

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"sync"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// detailsReactionConcurrency bounds the reaction reads of one dialog. A thread
// of 50 comments is 50 of them, and a small Forgejo shouldn't see them all at
// once.
const detailsReactionConcurrency = 8

// maxReactionsRead is how many reactions of one pull request description are
// read. Past it the thumbs count is a lower bound, which only matters for a
// description with more than 50 reactions of any kind. A comment's reactions
// are read whole, since Forgejo has no paged read for them.
const maxReactionsRead = 50

// GetPullRequestDetails implements dashboard.PullRequestDetailer: the
// description, the first comments and the thumbs reactions on each of
// owner/name#number (#1506).
//
// The cost is 1 call for the pull request, 1 for its reactions, 1 for the first
// comments page and 1 per comment for its reactions: at most 53. Forgejo has no
// batch read. The reaction reads run up to detailsReactionConcurrency at a time
// and stop at the first failure, a rate limit above all, which comes back as
// the error with its code. A half-loaded thread never comes back.
//
// Forgejo doesn't say whether a description was edited, so that is always
// false. A comment counts as edited when it was updated after it was created.
func (c *Client) GetPullRequestDetails(ctx context.Context, owner, name string, number int) (dashboard.PullRequestDetails, error) {
	c.setContext(ctx)

	pr, err := c.detailsPullRequest(ctx, owner, name, number)
	if err != nil {
		return dashboard.PullRequestDetails{}, err
	}
	descriptionReactions, err := c.detailsIssueReactions(ctx, owner, name, number)
	if err != nil {
		return dashboard.PullRequestDetails{}, err
	}
	comments, total, err := c.detailsComments(ctx, owner, name, number)
	if err != nil {
		return dashboard.PullRequestDetails{}, err
	}

	text, truncated := dashboard.CapText(pr.Body, dashboard.MaxDetailsBodyRunes)
	details := dashboard.PullRequestDetails{
		Description: dashboard.DetailsBody{
			Text: text, Format: dashboard.FormatMarkdown, Truncated: truncated, Reactions: descriptionReactions,
		},
		Comments:     make([]dashboard.DetailsComment, len(comments)),
		CommentCount: max(total, len(comments)),
	}
	details.CommentsTruncated = details.CommentCount > len(comments)

	reactionErr := c.eachConcurrently(len(comments), func(i int) error {
		reactions, err := c.detailsCommentReactions(ctx, owner, name, comments[i].ID)
		if err != nil {
			return err
		}
		details.Comments[i] = detailsCommentOf(comments[i], reactions)

		return nil
	})
	if reactionErr != nil {
		return dashboard.PullRequestDetails{}, reactionErr
	}

	return details, nil
}

func detailsCommentOf(comment *gitea.Comment, reactions dashboard.Reactions) dashboard.DetailsComment {
	text, truncated := dashboard.CapText(comment.Body, dashboard.MaxDetailsBodyRunes)
	out := dashboard.DetailsComment{
		ID:        strconv.FormatInt(comment.ID, 10),
		CreatedAt: comment.Created.UTC().Format("2006-01-02T15:04:05Z"),
		Edited:    comment.Updated.After(comment.Created),
		Text:      text, Format: dashboard.FormatMarkdown, Truncated: truncated, Reactions: reactions,
	}
	if out.Edited {
		updated := comment.Updated.UTC().Format("2006-01-02T15:04:05Z")
		out.UpdatedAt = &updated
	}
	if comment.Poster != nil {
		out.Author = &dashboard.Person{Login: comment.Poster.UserName, AvatarURL: comment.Poster.AvatarURL}
	}

	return out
}

func (c *Client) detailsPullRequest(ctx context.Context, owner, name string, number int) (*gitea.PullRequest, error) {
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	pr, resp, err := c.sdk.GetPullRequest(owner, name, int64(number))
	if err != nil {
		return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)

	return pr, nil
}

func (c *Client) detailsIssueReactions(ctx context.Context, owner, name string, number int) (dashboard.Reactions, error) {
	path := fmt.Sprintf("/repos/%s/%s/issues/%d/reactions", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	var opt gitea.ListIssueReactionsOptions
	opt.Page, opt.PageSize = 1, maxReactionsRead
	reactions, resp, err := c.sdk.ListIssueReactions(owner, name, int64(number), opt)
	if err != nil {
		return dashboard.Reactions{}, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)

	return reactionsOf(reactions), nil
}

func (c *Client) detailsCommentReactions(ctx context.Context, owner, name string, commentID int64) (dashboard.Reactions, error) {
	path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d/reactions", owner, name, commentID)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	reactions, resp, err := c.sdk.GetIssueCommentReactions(owner, name, commentID)
	if err != nil {
		return dashboard.Reactions{}, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)

	return reactionsOf(reactions), nil
}

// detailsComments reads the first page of a pull request's comments, oldest
// first, and the total Forgejo reports in X-Total-Count (0 when it doesn't).
func (c *Client) detailsComments(ctx context.Context, owner, name string, number int) ([]*gitea.Comment, int, error) {
	path := fmt.Sprintf("/repos/%s/%s/issues/%d/comments", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	var opt gitea.ListIssueCommentOptions
	opt.Page, opt.PageSize = 1, dashboard.MaxDetailsComments
	comments, resp, err := c.sdk.ListIssueComments(owner, name, int64(number), opt)
	if err != nil {
		return nil, 0, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)
	if len(comments) > dashboard.MaxDetailsComments {
		comments = comments[:dashboard.MaxDetailsComments]
	}
	total, _ := strconv.Atoi(resp.Header.Get("X-Total-Count"))

	return comments, total, nil
}

// eachConcurrently runs fn for 0..n-1, detailsReactionConcurrency at a time.
// After the first error no further call starts, and that error comes back.
func (c *Client) eachConcurrently(n int, fn func(i int) error) error {
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		firstErr error
		slots    = make(chan struct{}, detailsReactionConcurrency)
	)
	for i := range n {
		slots <- struct{}{}
		mu.Lock()
		failed := firstErr != nil
		mu.Unlock()
		if failed {
			<-slots

			break
		}
		wg.Go(func() {
			defer func() { <-slots }()
			if err := fn(i); err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
			}
		})
	}
	wg.Wait()

	return firstErr
}

// reactionsOf keeps the two reactions the dialog shows. Forgejo names them
// "+1" and "-1"; any other reaction is not counted. Always arrays, never null.
func reactionsOf(reactions []*gitea.Reaction) dashboard.Reactions {
	out := dashboard.Reactions{
		ThumbsUp:   dashboard.Reaction{Logins: []string{}},
		ThumbsDown: dashboard.Reaction{Logins: []string{}},
	}
	var up, down []string
	for _, r := range reactions {
		login := ""
		if r.User != nil {
			login = r.User.UserName
		}
		switch r.Reaction {
		case "+1":
			up = append(up, login)
		case "-1":
			down = append(down, login)
		}
	}
	out.ThumbsUp = dashboard.Reaction{Count: len(up), Logins: dashboard.CapLogins(up)}
	out.ThumbsDown = dashboard.Reaction{Count: len(down), Logins: dashboard.CapLogins(down)}

	return out
}
