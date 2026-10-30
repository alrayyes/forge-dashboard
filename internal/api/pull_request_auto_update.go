package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"unicode/utf8"

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

// handlePullRequestAutoUpdate implements POST /api/v1/pull-requests/auto-update: a
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
		var req pullRequestAutoUpdateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}

		field, serr := setPullRequestAutoUpdateFor(r.Context(), deps, req)
		if serr != nil {
			if field != "" {
				writeJSON(w, serr.status, fieldErrorBody(field, serr.message))
			} else {
				serr.write(w)
			}

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// setPullRequestAutoUpdateFor validates req and saves the choice. Shared
// by handlePullRequestAutoUpdate and the MCP set_pull_request_auto_update tool
// so the two can't drift. The *statusError carries the HTTP status the handler
// answers with; the string names the request field a 400 is about, "" if none.
func setPullRequestAutoUpdateFor(ctx context.Context, deps Deps, req pullRequestAutoUpdateRequest) (string, *statusError) {
	if field, serr := pullRequestTargetProblem(req.Forge, req.FullName, req.Number); serr != nil {
		return field, serr
	}

	if _, found := deps.Service.FindPullRequest(dashboard.Forge(req.Forge), req.FullName, req.Number); !found {
		return "", &statusError{http.StatusNotFound, "pull request not found"}
	}

	if err := saveAutoUpdateChoice(ctx, deps.SettingsStore, req); err != nil {
		slog.Warn("could not save pull request auto-update choice", "error", err)

		return "", &statusError{http.StatusInternalServerError, "could not save"}
	}

	return "", nil
}

// saveAutoUpdateChoice keeps req's choice only while it differs from the repo's
// setting, and drops any earlier one otherwise.
func saveAutoUpdateChoice(ctx context.Context, store *settings.Store, req pullRequestAutoUpdateRequest) error {
	if req.Enabled == nil {
		return wrapAutoUpdate(store.ClearPullRequestAutoUpdate(ctx, req.Forge, req.FullName, req.Number))
	}
	repos, err := store.AutoUpdateBranchRepos(ctx)
	if err != nil {
		return wrapAutoUpdate(err)
	}
	_, repoEnabled := repos[settings.WebhookDeliveryKey(req.Forge, req.FullName)]
	if *req.Enabled == repoEnabled {
		return wrapAutoUpdate(store.ClearPullRequestAutoUpdate(ctx, req.Forge, req.FullName, req.Number))
	}

	return wrapAutoUpdate(store.SetPullRequestAutoUpdate(ctx, req.Forge, req.FullName, req.Number, *req.Enabled))
}

// wrapAutoUpdate names the operation on a store error, for the log line.
func wrapAutoUpdate(err error) error {
	if err != nil {
		return fmt.Errorf("save pull request auto-update choice: %w", err)
	}

	return nil
}

// pullRequestTargetProblem refuses, with a 400, a forge, "owner/repo" or number
// a client could not have read from the dashboard. The string names the request
// field it is about, "" when it is the whole name.
func pullRequestTargetProblem(forge, fullName string, number int) (string, *statusError) {
	if utf8.RuneCountInString(fullName) > maxRepoFullNameLen {
		return "fullName", &statusError{http.StatusBadRequest, "fullName is too long"}
	}
	if _, _, ok := splitFullName(fullName); !ok {
		return "", &statusError{http.StatusBadRequest, `fullName must be "owner/repo"`}
	}
	if forge != string(dashboard.ForgeGitHub) && forge != string(dashboard.ForgeForgejo) {
		return "forge", &statusError{http.StatusBadRequest, "forge must be github or forgejo"}
	}
	if number < 1 || number > maxPullRequestNumber {
		return "number", &statusError{http.StatusBadRequest, "number must be a pull request number"}
	}

	return "", nil
}
