package github

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
)

// annotateUpToDateRule sets BaseRequiresUpToDate on every behind pull request,
// from its base branch's protection. The answer is cached per branch, so a
// refresh costs no call per pull request, and a pull request that isn't behind
// costs none at all.
func (c *Client) annotateUpToDateRule(ctx context.Context, prs []dashboard.PullRequest) {
	for i := range prs {
		if !prs[i].Behind || prs[i].BaseBranch == "" {
			continue
		}
		owner, name, ok := strings.Cut(prs[i].Repo, "/")
		if !ok {
			continue
		}
		prs[i].BaseRequiresUpToDate = c.requiresUpToDate(ctx, owner, name, prs[i].BaseBranch)
	}
}

// requiresUpToDate reads the classic branch protection's "strict" flag: nil
// when it can't be read (no admin scope) or the branch has no classic rule,
// since a ruleset may require it instead and nothing is guessed.
func (c *Client) requiresUpToDate(ctx context.Context, owner, name, base string) *bool {
	key := owner + "/" + name + "@" + base
	if cached, ok := c.upToDate.Cached(key); ok {
		return cached
	}
	path := fmt.Sprintf("/repos/%s/%s/branches/%s/protection/required_status_checks", owner, name, base)
	slog.Debug("github request", "method", http.MethodGet, "url", path)
	prot, resp, err := c.restClient.Repositories.GetRequiredStatusChecks(ctx, owner, name, base)
	var required *bool
	switch {
	case err == nil:
		c.recordRESTSuccess(ctx, http.MethodGet, path, resp)
		required = new(prot.Strict)
	case errors.Is(err, ghsdk.ErrBranchNotProtected):
	default:
		slog.Debug("github branch protection unreadable, up-to-date rule stays unknown", "repo", owner+"/"+name, "branch", base, "error", err)
	}
	c.upToDate.Store(key, required)

	return required
}
