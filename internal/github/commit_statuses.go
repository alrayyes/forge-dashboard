package github

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"slices"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
)

// commitStatuses lists a commit's statuses as checks, one request for each
// perPage of them.
func (c *Client) commitStatuses(ctx context.Context, owner, name, sha string) ([]dashboard.Check, error) {
	path := fmt.Sprintf("/repos/%s/%s/commits/%s/status", owner, name, sha)
	checks := []dashboard.Check{}
	opts := &ghsdk.ListOptions{PerPage: perPage}
	for {
		slog.Debug("github request", "method", http.MethodGet, "url", path)
		combined, resp, err := c.restClient.Repositories.GetCombinedStatus(ctx, owner, name, sha, opts)
		if err != nil {
			return nil, asClientError(c.restError(ctx, http.MethodGet, path, err))
		}
		c.recordRESTSuccess(ctx, http.MethodGet, path, resp)
		for _, s := range combined.Statuses {
			checks = append(checks, dashboard.Check{
				Name:  s.GetContext(),
				State: checkStateFromCombinedState(s.GetState()),
				// The legacy status carries its word in the state.
				ReportedStatus: dashboard.UnknownWord(checkStateFromCombinedState(s.GetState()), s.GetState()),
				URL:            s.GetTargetURL(),
			})
		}
		if resp.NextPage == 0 {
			return checks, nil
		}
		opts.Page = resp.NextPage
	}
}

// withStatuses adds the commit's statuses to its check runs (#5101): the row
// counts both. A status that says what a check run of the same name says is the
// same job reported twice, so it is left out. A failed read keeps the runs.
func (c *Client) withStatuses(ctx context.Context, owner, name, sha string, runs []dashboard.Check) []dashboard.Check {
	if c.statusPresence.none(owner+"/"+name, sha) {
		return runs
	}
	statuses, err := c.commitStatuses(ctx, owner, name, sha)
	if err != nil {
		slog.Warn("github commit status lookup failed", "forge", dashboard.ForgeGitHub, "error", err)

		return runs
	}
	fresh := slices.DeleteFunc(statuses, func(s dashboard.Check) bool {
		return slices.ContainsFunc(runs, func(r dashboard.Check) bool { return sameJob(r, s) })
	})

	return append(runs, fresh...)
}

// sameJob reports that a check run and a commit status have one name and one
// outcome. Where they disagree both are listed, as hiding either would hide a
// failure or a wait.
func sameJob(run, status dashboard.Check) bool {
	outcome := outcomeOf(run.State)

	return run.Name == status.Name && outcome != "" && outcome == outcomeOf(status.State)
}

// outcomeOf folds a check state into the three a commit status can say, or ""
// for a state it has no word for.
func outcomeOf(state dashboard.CheckState) string {
	switch state {
	case dashboard.CheckSuccess:
		return "passed"
	case dashboard.CheckFailure, dashboard.CheckTimedOut:
		return "failed"
	case dashboard.CheckQueued, dashboard.CheckRunning:
		return "unfinished"
	default:
		return ""
	}
}
