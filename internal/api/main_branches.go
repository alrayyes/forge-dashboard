package api

import (
	"net/http"
	"slices"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
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
	Branches    []mainBranchView           `json:"branches"`
}

// buildMainBranchesResponse orders snap's rows failed first and counts them. A
// row is never left out, whatever its status: the client filters, and its pill
// counts then always match what each pill lists.
func buildMainBranchesResponse(snap dashboard.Snapshot) mainBranchesResponse {
	rows := slices.Clone(snap.MainBranches)
	dashboard.SortMainBranches(rows)

	views := make([]mainBranchView, 0, len(rows))
	for _, r := range rows {
		if r.FailingJobs == nil {
			r.FailingJobs = []string{}
		}
		views = append(views, mainBranchView{MainBranch: r, Stale: r.StaleSince != nil})
	}

	return mainBranchesResponse{
		GeneratedAt: snap.GeneratedAt,
		Counts:      dashboard.CountMainBranches(rows),
		Branches:    views,
	}
}

// handleMainBranches answers the CI status of every tracked repo's default
// branch (#1224) from the snapshot the background refresh already holds. It
// never calls a forge, so it costs no rate-limit budget however often a page
// reads it. Only the signed-in user's own dashboard, like the stream and the
// refresh: sharing is for the dashboard board.
func handleMainBranches(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		warmUpAggregator(r.Context(), deps, u.ID, u.Username)
		deps.Manager.WaitFirstRefresh(r.Context(), u.ID, firstLoadWait)

		writeJSON(w, http.StatusOK, buildMainBranchesResponse(deps.Manager.Get(u.ID)))
	}
}
