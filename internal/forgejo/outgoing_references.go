package forgejo

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// outgoingReferences lists what an issue or pull request's own text refers to
// (#4272). Forgejo's timeline records only what refers to an item, so the text
// is read the way the board reads a pull request's and each named item is
// looked up, one request each, at most dashboard.MaxOutgoingReferences. It is
// best effort: an item that can't be read is left out, and a failure of the
// forge itself ends the lookups and keeps what was found.
func (c *Client) outgoingReferences(ctx context.Context, kind dashboard.ItemKind, title, body, owner, name string, number int) []dashboard.ItemReference {
	fullName := owner + "/" + name

	return dashboard.OutgoingReferences(ctx, dashboard.ForgeForgejo, kind, title, body, fullName, number, c.instanceURL, c.lookUpTargets)
}

func (c *Client) lookUpTargets(ctx context.Context, targets []dashboard.OutgoingTarget) []dashboard.ItemReference {
	var refs []dashboard.ItemReference
	for _, target := range targets {
		owner, name, _ := strings.Cut(target.Repo, "/")
		path := fmt.Sprintf("/repos/%s/%s/issues/%d", owner, name, target.Number)
		slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
		issue, resp, err := c.withContext(ctx).sdk.GetIssue(owner, name, int64(target.Number))
		if err != nil {
			err = c.forgejoError(ctx, http.MethodGet, path, resp, err)
			if clientErr, ok := errors.AsType[*dashboard.ClientError](err); ok && clientErr.Kind == dashboard.ForgeErrorNotFound {
				continue
			}
			slog.Warn("forgejo outgoing references lookup failed", "error", err)

			return refs
		}
		c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)

		refs = append(refs, referenceTo(target.Repo, issue))
	}

	return refs
}

// referenceTo is the reference an issue read from Forgejo makes, as the
// outgoing entry for the item named as repo.
func referenceTo(repo string, issue *gitea.Issue) dashboard.ItemReference {
	ref := dashboard.ItemReference{
		Forge: dashboard.ForgeForgejo, Repo: repo, Number: int(issue.Index), Title: issue.Title,
		URL: issue.HTMLURL, Kind: dashboard.ItemKindIssue, State: dashboard.ReferencedStateOpen,
	}
	if issue.Repository != nil && issue.Repository.FullName != "" {
		ref.Repo = issue.Repository.FullName
	}
	if issue.PullRequest != nil {
		ref.Kind = dashboard.ItemKindPullRequest
	}
	if issue.State == gitea.StateClosed {
		ref.State = dashboard.ReferencedStateClosed
		if issue.PullRequest != nil && issue.PullRequest.HasMerged {
			ref.State = dashboard.ReferencedStateMerged
		}
	}

	return ref
}
