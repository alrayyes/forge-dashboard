package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// maxHideDays is the longest a pull request can be hidden for a number of days.
// A hide with no end is the way to keep one hidden longer.
const maxHideDays = 365

// pullRequestHideRequest matches components.schemas.PullRequestHideRequest.
// Days is a pointer so a missing value (hide until restored) differs from 0.
type pullRequestHideRequest struct {
	Forge    string `json:"forge"`
	FullName string `json:"fullName"`
	Number   int    `json:"number"`
	Days     *int   `json:"days"`
}

// readHiddenTarget reads and checks who is asking and which pull request, and
// answers 500 or 400 itself when it can't. A hide is a local write: nothing
// here touches a forge, so it needs no credentials and no forge source.
func readHiddenTarget(w http.ResponseWriter, r *http.Request) (*auth.User, pullRequestHideRequest, bool) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

		return nil, pullRequestHideRequest{}, false
	}

	var req pullRequestHideRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

		return nil, req, false
	}
	if overBound(w, bound{"fullName", req.FullName, maxRepoFullNameLen}) {
		return nil, req, false
	}
	if _, _, ok := splitFullName(req.FullName); !ok {
		writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

		return nil, req, false
	}
	if req.Forge != string(dashboard.ForgeGitHub) && req.Forge != string(dashboard.ForgeForgejo) {
		writeJSON(w, http.StatusBadRequest, fieldErrorBody("forge", "forge must be github or forgejo"))

		return nil, req, false
	}
	if req.Number < 1 || req.Number > maxPullRequestNumber {
		writeJSON(w, http.StatusBadRequest, fieldErrorBody("number", "number must be a pull request number"))

		return nil, req, false
	}

	return u, req, true
}

// handlePullRequestHide implements POST /api/pull-requests/hide (#841): a pure
// local write to settings.Store, like ignoring a repo. A repeat call with a new
// choice replaces the old one.
func handlePullRequestHide(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, req, ok := readHiddenTarget(w, r)
		if !ok {
			return
		}
		var until time.Time
		if req.Days != nil {
			if *req.Days < 1 || *req.Days > maxHideDays {
				writeJSON(w, http.StatusBadRequest, fieldErrorBody("days", "days must be between 1 and 365"))

				return
			}
			until = time.Now().AddDate(0, 0, *req.Days)
		}

		if err := deps.SettingsStore.HidePullRequest(r.Context(), u.ID, req.Forge, req.FullName, req.Number, until); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save"))

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handlePullRequestUnhide implements POST /api/pull-requests/unhide, the
// reverse of handlePullRequestHide. Idempotent.
func handlePullRequestUnhide(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, req, ok := readHiddenTarget(w, r)
		if !ok {
			return
		}

		if err := deps.SettingsStore.UnhidePullRequest(r.Context(), u.ID, req.Forge, req.FullName, req.Number); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save"))

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
