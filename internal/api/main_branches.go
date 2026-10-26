package api

import (
	"context"
	"net/http"
	"slices"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// mainBranchesResponse matches components.schemas.MainBranches.
type mainBranchesResponse struct {
	GeneratedAt time.Time `json:"generatedAt"`
	// Forges is each forge's health, as the dashboard snapshot carries it, so
	// the page can lock a control the forge would only refuse.
	Forges   []dashboard.ForgeHealth `json:"forges"`
	Branches []dashboard.MainBranch  `json:"branches"`
}

// mainBranchRows is snap's default branches without the repos the user ignored
// for pull requests, so Branches, and the nav badge the page counts from it,
// follow the same ignore list as the pull requests page (#1337). A repo ignored
// only for issues stays.
func (b boardSettings) mainBranchRows(rows []dashboard.MainBranch) []dashboard.MainBranch {
	return slices.DeleteFunc(slices.Clone(rows), func(r dashboard.MainBranch) bool {
		return b.ignored[settings.WebhookDeliveryKey(string(r.Forge), r.FullName)].PRs
	})
}

// buildMainBranchesResponse leaves the rows in the order the snapshot holds
// them: the client orders and tallies them. A row the caller passes is never
// left out, whatever its status: the client filters, and its pill counts then
// always match what each pill lists.
func buildMainBranchesResponse(generatedAt time.Time, forges []dashboard.ForgeHealth, branches []dashboard.MainBranch) mainBranchesResponse {
	rows := slices.Clone(branches)
	if rows == nil {
		rows = []dashboard.MainBranch{}
	}
	for i := range rows {
		if rows[i].FailingJobs == nil {
			rows[i].FailingJobs = []string{}
		}
	}

	return mainBranchesResponse{
		GeneratedAt: generatedAt,
		Forges:      forges,
		Branches:    rows,
	}
}

// resolveMainBranchesFor answers the CI status of every tracked repo's default
// branch (#1224) from the snapshot the background refresh already holds.
// It never calls a forge, so it costs no rate-limit budget however often it's
// read. Shared by handleMainBranches and the MCP get_main_branches tool so the
// two can't drift.
func resolveMainBranchesFor(ctx context.Context, deps Deps) mainBranchesResponse {
	snap, rows := followedSnapshot(ctx, deps)

	return buildMainBranchesResponse(snap.GeneratedAt, snap.Forges, rows)
}

// followedSnapshot waits for the first refresh, then returns the snapshot with
// the main branch rows the user's Main branches page shows from it.
func followedSnapshot(ctx context.Context, deps Deps) (dashboard.Snapshot, []dashboard.MainBranch) {
	warmUpAggregator(ctx, deps)
	deps.Service.WaitFirstRefresh(ctx, deps.firstLoadWait())

	snap := deps.Service.Get()

	return snap, followedRows(ctx, deps, snap)
}

// followedRows is the one rule for which main branch rows the user follows,
// shared by the page and by the routes that check a repository is followed.
// It reads the board settings, so a caller that may not need the rows calls
// it late.
func followedRows(ctx context.Context, deps Deps, snap dashboard.Snapshot) []dashboard.MainBranch {
	return loadBoardSettings(ctx, deps.SettingsStore).mainBranchRows(snap.MainBranches)
}

// handleMainBranches serves resolveMainBranchesFor over HTTP.
func handleMainBranches(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, resolveMainBranchesFor(r.Context(), deps))
	}
}
