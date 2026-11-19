package forgejo

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// GetIssueDetails implements dashboard.IssueDetailer: the description, the
// first comments and the thumbs reactions on each of owner/name#number, and
// what refers to it. The requests are the issue, its reactions, its comments,
// each shown comment's reactions (up to MaxDetailsComments), and the timeline:
// one request per page of events, at least two (one page and the empty page
// that ends the read) and at most maxTimelinePages. A thread with more than
// maxTimelinePages pages of events keeps the references on the first ones, the
// oldest, since the timeline lists oldest first. Then one request for each item
// its own text names (at most dashboard.MaxOutgoingReferences).
func (c *Client) GetIssueDetails(ctx context.Context, owner, name string, number int) (dashboard.IssueDetails, error) {
	c = c.withContext(ctx)

	path := fmt.Sprintf("/repos/%s/%s/issues/%d", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	issue, resp, err := c.sdk.GetIssue(owner, name, int64(number))
	if err != nil {
		return dashboard.IssueDetails{}, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)

	details, err := c.threadDetails(ctx, owner, name, number, issue.Body)
	if err != nil {
		return dashboard.IssueDetails{}, err
	}
	details.Kind = dashboard.ItemKindIssue
	// The references are an addition to the thread, so a timeline that fails
	// leaves the issue with the ones read before it failed instead of failing
	// the whole read. A caller that gave up still gets the error.
	details.References, err = c.incomingReferences(ctx, owner, name, number)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return dashboard.IssueDetails{}, fmt.Errorf("forgejo: read timeline: %w", ctxErr)
		}
		slog.Debug("forgejo timeline unavailable", "repo", owner+"/"+name, "issue", number, "err", err)
	}
	if issue.PullRequest != nil {
		details.Kind = dashboard.ItemKindPullRequest
		details.PullRequest = &dashboard.IssuePullRequest{Title: issue.Title, State: dashboard.ReferencedStateOpen}
		if issue.State == gitea.StateClosed {
			details.PullRequest.State = dashboard.ReferencedStateClosed
			if issue.PullRequest.HasMerged {
				details.PullRequest.State = dashboard.ReferencedStateMerged
			}
		}
		if issue.Poster != nil {
			details.PullRequest.Author = &dashboard.Person{Login: issue.Poster.UserName, AvatarURL: issue.Poster.AvatarURL}
		}
	}
	details.State = dashboard.IssueStateOpen
	if issue.State == gitea.StateClosed {
		details.State = dashboard.IssueStateClosed
	}
	details.References = append(details.References, c.outgoingReferences(ctx, details.Kind, issue.Title, issue.Body, owner, name, number)...)

	return details, nil
}

// Forgejo's timeline types for a reference from another issue, pull request or
// comment, from commentStrings in models/issues/comment.go. A commit_ref has
// no issue behind it and is left out.
var referenceEvents = map[string]bool{"issue_ref": true, "pull_ref": true, "comment_ref": true}

// timelineReference is one timeline event as far as a reference reads it.
type timelineReference struct {
	Type      string `json:"type"`
	RefAction string `json:"ref_action"`
	RefIssue  *struct {
		Number      int    `json:"number"`
		Title       string `json:"title"`
		State       string `json:"state"`
		HTMLURL     string `json:"html_url"`
		PullRequest *struct {
			Merged bool `json:"merged"`
		} `json:"pull_request"`
		Repository *struct {
			FullName string `json:"full_name"`
		} `json:"repository"`
	} `json:"ref_issue"`
}

// timelineReferences reads the issue's timeline, one request per page of
// events and an empty page to end on, as the scheduled merge read does. A page
// that fails returns the events of the pages before it along with the error.
func (c *Client) timelineReferences(ctx context.Context, owner, name string, number int) ([]timelineReference, error) {
	var events []timelineReference
	for page := 1; page <= maxTimelinePages; page++ {
		path := fmt.Sprintf("/repos/%s/%s/issues/%d/timeline?page=%d&limit=%d", owner, name, number, page, pageLimit)
		slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
		body, resp, err := c.rawRequest(ctx, http.MethodGet, path, nil)
		if err != nil {
			return events, c.forgejoError(ctx, http.MethodGet, path, resp, err)
		}
		var batch []timelineReference
		if err := json.Unmarshal(body, &batch); err != nil {
			return events, fmt.Errorf("forgejo: unmarshal timeline response: %w", err)
		}
		if len(batch) == 0 {
			break
		}
		events = append(events, batch...)
	}

	return events, nil
}

// incomingReferences returns the items that refer to the issue, from its
// timeline. When the read fails part way it returns the ones read so far along
// with the error.
func (c *Client) incomingReferences(ctx context.Context, owner, name string, number int) ([]dashboard.ItemReference, error) {
	events, err := c.timelineReferences(ctx, owner, name, number)

	var refs []dashboard.ItemReference
	for _, e := range events {
		if !referenceEvents[e.Type] || e.RefIssue == nil || e.RefIssue.Repository == nil || e.RefIssue.Number == 0 {
			continue
		}
		relation := dashboard.RelationMentions
		if e.RefAction == "closes" {
			relation = dashboard.RelationCloses
		}
		repo := e.RefIssue.Repository.FullName
		ref := dashboard.ItemReference{
			Forge: dashboard.ForgeForgejo, Repo: repo, Number: e.RefIssue.Number,
			Title: e.RefIssue.Title, URL: e.RefIssue.HTMLURL, Kind: dashboard.ItemKindIssue,
			State: dashboard.ReferencedStateOpen, Direction: dashboard.ReferenceIncoming, Relation: relation,
		}
		if e.RefIssue.PullRequest != nil {
			ref.Kind = dashboard.ItemKindPullRequest
		}
		if e.RefIssue.State == string(gitea.StateClosed) {
			ref.State = dashboard.ReferencedStateClosed
			if e.RefIssue.PullRequest != nil && e.RefIssue.PullRequest.Merged {
				ref.State = dashboard.ReferencedStateMerged
			}
		}
		refs = append(refs, ref)
	}

	return dashboard.NewestFirstReferences(refs), err
}
