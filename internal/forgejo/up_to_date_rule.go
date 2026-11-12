package forgejo

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// annotateUpToDateRule sets BaseRequiresUpToDate on every behind pull request,
// from its base branch's "block merge if the pull request is outdated" rule
// (#3428). The answer is cached per branch, so a refresh costs no call per pull
// request, and a pull request that isn't behind costs none at all.
func (c *Client) annotateUpToDateRule(ctx context.Context, owner, name string, prs []dashboard.PullRequest) {
	for i := range prs {
		if !prs[i].Behind || prs[i].BaseBranch == "" {
			continue
		}
		prs[i].BaseRequiresUpToDate = c.requiresUpToDate(ctx, owner, name, prs[i].BaseBranch)
	}
}

// requiresUpToDate is nil when the protection list can't be read (it needs
// admin on the repo). With the list in hand, a branch no rule covers requires
// nothing.
func (c *Client) requiresUpToDate(ctx context.Context, owner, name, base string) *bool {
	key := owner + "/" + name + "@" + base
	if cached, ok := c.upToDate.Cached(key); ok {
		return cached
	}
	c = c.withContext(ctx)
	protPath := fmt.Sprintf("/repos/%s/%s/branch_protections", owner, name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", protPath)
	var opt gitea.ListBranchProtectionsOptions
	opt.PageSize = pageLimit
	rules, resp, err := c.sdk.ListBranchProtections(owner, name, opt)
	var required *bool
	if err != nil {
		slog.Debug("forgejo branch protections unreadable, up-to-date rule stays unknown", "repo", owner+"/"+name, "branch", base, "error", err)
	} else {
		c.recordRequest(ctx, http.MethodGet, protPath, resp.StatusCode, requestlog.OutcomeSuccess)
		rule := protectionForBranch(rules, base)
		required = new(rule != nil && rule.BlockOnOutdatedBranch)
	}
	if ctx.Err() != nil {
		return nil
	}
	c.upToDate.Store(key, required)

	return required
}
