package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// pullRequestAutoUpdateRequest matches components.schemas.PullRequestAutoUpdateRequest.
// Enabled is a pointer so a null or missing value (follow the repo again)
// differs from false (never update this one).
type pullRequestAutoUpdateRequest struct {
	Forge    string `json:"forge"`
	FullName string `json:"fullName"`
	Number   int    `json:"number"`
	Enabled  *bool  `json:"enabled"`
}

// handlePullRequestAutoUpdate implements POST /api/pull-requests/auto-update: a
// pure local write to settings.Store, like hiding a pull request. A choice that
// equals the repo's own setting is not kept, so the pull request follows the
// repo again and a later change to the repo's setting reaches it. A pull
// request the dashboard doesn't hold is a 404.
//
// The read of the repo's setting and the write of the choice are not one
// transaction. A repo switched in between leaves a choice equal to it, which
// every reader treats as following the repo, and the next background pass
// deletes it.
func handlePullRequestAutoUpdate(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}
		var req pullRequestAutoUpdateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}
		if !validPullRequestTarget(w, req.Forge, req.FullName, req.Number) {
			return
		}

		if _, found := deps.Manager.FindPullRequest(u.ID, dashboard.Forge(req.Forge), req.FullName, req.Number); !found {
			writeJSON(w, http.StatusNotFound, errorBody("pull request not found"))

			return
		}

		if err := saveAutoUpdateChoice(r, deps.SettingsStore, u.ID, req); err != nil {
			slog.Warn("could not save pull request auto-update choice", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save"))

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// saveAutoUpdateChoice keeps req's choice only while it differs from the repo's
// setting, and drops any earlier one otherwise.
func saveAutoUpdateChoice(r *http.Request, store *settings.Store, userID []byte, req pullRequestAutoUpdateRequest) error {
	ctx := r.Context()
	if req.Enabled == nil {
		return wrapAutoUpdate(store.ClearPullRequestAutoUpdate(ctx, userID, req.Forge, req.FullName, req.Number))
	}
	repos, err := store.AutoUpdateBranchRepos(ctx, userID)
	if err != nil {
		return wrapAutoUpdate(err)
	}
	_, repoEnabled := repos[settings.WebhookDeliveryKey(req.Forge, req.FullName)]
	if *req.Enabled == repoEnabled {
		return wrapAutoUpdate(store.ClearPullRequestAutoUpdate(ctx, userID, req.Forge, req.FullName, req.Number))
	}

	return wrapAutoUpdate(store.SetPullRequestAutoUpdate(ctx, userID, req.Forge, req.FullName, req.Number, *req.Enabled))
}

// wrapAutoUpdate names the operation on a store error, for the log line.
func wrapAutoUpdate(err error) error {
	if err != nil {
		return fmt.Errorf("save pull request auto-update choice: %w", err)
	}

	return nil
}

// validPullRequestTarget answers 400 itself when the forge, "owner/repo" or
// number is not one a client could have read from the dashboard.
func validPullRequestTarget(w http.ResponseWriter, forge, fullName string, number int) bool {
	if overBound(w, bound{"fullName", fullName, maxRepoFullNameLen}) {
		return false
	}
	if _, _, ok := splitFullName(fullName); !ok {
		writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

		return false
	}
	if forge != string(dashboard.ForgeGitHub) && forge != string(dashboard.ForgeForgejo) {
		writeJSON(w, http.StatusBadRequest, fieldErrorBody("forge", "forge must be github or forgejo"))

		return false
	}
	if number < 1 || number > maxPullRequestNumber {
		writeJSON(w, http.StatusBadRequest, fieldErrorBody("number", "number must be a pull request number"))

		return false
	}

	return true
}
