package api

import (
	"context"
	"net/http"
	"slices"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// mainBranchView is a default-branch row as the API serves it: the snapshot's
// own fields plus the stale flag a client branches on.
type mainBranchView struct {
	dashboard.MainBranch
	// Stale is true when StaleSince is set: the row is the last known one
	// because its forge couldn't be read or has no budget left (#1199).
	Stale bool `json:"stale"`
}

// mainBranchesResponse matches components.schemas.MainBranches.
type mainBranchesResponse struct {
	GeneratedAt time.Time                  `json:"generatedAt"`
	Counts      dashboard.MainBranchCounts `json:"counts"`
	// Forges is each forge's health, as the dashboard snapshot carries it, so
	// the page can lock a control the forge would only refuse.
	Forges   []dashboard.ForgeHealth `json:"forges"`
	Branches []mainBranchView        `json:"branches"`
}

// mainBranchRows is snap's default branches without the repos the user ignored
// for pull requests, so Branches and navCounts.branches follow the same ignore
// list as the pull requests page (#1337). A repo ignored only for issues stays.
func (b boardSettings) mainBranchRows(rows []dashboard.MainBranch) []dashboard.MainBranch {
	return slices.DeleteFunc(slices.Clone(rows), func(r dashboard.MainBranch) bool {
		return b.ignored[settings.WebhookDeliveryKey(string(r.Forge), r.FullName)].PRs
	})
}

// buildMainBranchesResponse orders the rows newest commit first and counts
// them. A row the caller passes is never left out, whatever its status: the
// client filters, and its pill counts then always match what each pill lists.
func buildMainBranchesResponse(generatedAt, now time.Time, forges []dashboard.ForgeHealth, branches []dashboard.MainBranch) mainBranchesResponse {
	rows := slices.Clone(branches)
	dashboard.SortMainBranches(rows)

	views := make([]mainBranchView, 0, len(rows))
	for _, r := range rows {
		if r.FailingJobs == nil {
			r.FailingJobs = []string{}
		}
		views = append(views, mainBranchView{MainBranch: r, Stale: r.StaleSince != nil})
	}

	return mainBranchesResponse{
		GeneratedAt: generatedAt,
		Counts:      dashboard.CountMainBranches(rows),
		Forges:      withRateLimitSeverity(forges, now),
		Branches:    views,
	}
}

// resolveMainBranchesFor answers the CI status of every tracked repo's default
// branch (#1224) from the snapshot the background refresh already holds.
// It never calls a forge, so it costs no rate-limit budget however often it's
// read. Shared by handleMainBranches and the MCP get_main_branches tool so the
// two can't drift.
func resolveMainBranchesFor(ctx context.Context, deps Deps) mainBranchesResponse {
	snap, rows := followedSnapshot(ctx, deps)

	return buildMainBranchesResponse(snap.GeneratedAt, time.Now(), snap.Forges, rows)
}

// followedSnapshot waits for the first refresh, then returns the snapshot with
// the main branch rows the user's Main branches page shows from it. It is the
// one rule for which repositories those are, shared by the page and by the
// routes that check a repository is followed.
func followedSnapshot(ctx context.Context, deps Deps) (dashboard.Snapshot, []dashboard.MainBranch) {
	warmUpAggregator(ctx, deps)
	deps.Service.WaitFirstRefresh(ctx, deps.firstLoadWait())

	snap := deps.Service.Get()
	board := loadBoardSettings(ctx, deps.SettingsStore)

	return snap, board.mainBranchRows(snap.MainBranches)
}

// handleMainBranches serves resolveMainBranchesFor over HTTP.
func handleMainBranches(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, resolveMainBranchesFor(r.Context(), deps))
	}
}
