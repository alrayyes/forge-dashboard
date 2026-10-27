package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// pullRequestChecksResponse is what the MCP check tools return.
type pullRequestChecksResponse struct {
	Checks []dashboard.Check `json:"checks"`
}

// resolvePullRequestChecksFor lists every individual job/check run against the
// named pull request's head commit for u: it resolves which source answers and
// has dashboard.PullRequestChecker do the per-forge fetch. Shared by
// the check stream and the MCP get_pull_request_checks tool so the two can't
// drift. The *statusError carries the status a failure maps to.
func resolvePullRequestChecksFor(ctx context.Context, deps Deps, forge, fullName string, number int) ([]dashboard.Check, *statusError) {
	owner, name, ok := splitFullName(fullName)
	if !ok {
		return nil, &statusError{http.StatusBadRequest, `fullName must be "owner/repo"`}
	}

	src, _, serr := lookupForgeSource(ctx, deps, forge)
	if serr != nil {
		return nil, serr
	}
	checker, serr := capabilityFor[dashboard.PullRequestChecker](src, forge, "doesn't support listing pull request checks")
	if serr != nil {
		return nil, serr
	}

	checks, err := checker.ListChecks(ctx, owner, name, number)
	if err != nil {
		slog.Warn("pull request checks fetch failed", "forge", forge, "repo", fullName, "number", number, "error", err)

		return nil, &statusError{clientErrorStatus(err), err.Error()}
	}

	return dashboard.WithFacts(checks), nil
}
