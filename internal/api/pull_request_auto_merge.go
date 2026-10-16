package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// handlePullRequestAutoMerge arms auto-merge on the named pull request. On
// GitHub that is the forge's own native auto-merge, which
// dashboard.PullRequestAutoMerger's EnableAutoMerge decides how to switch on.
// On Forgejo it is this app's own intent: the background pass merges it once
// checks pass. A merge scheduled on Forgejo itself is read from the timeline.
func handlePullRequestAutoMerge(deps Deps) http.HandlerFunc {
	github := guardedAction[dashboard.PullRequestAutoMerger]{
		allowed:     dashboard.ActionAutoMerge,
		refusal:     dashboard.PullRequestActionAutoMerge,
		unsupported: "doesn't support enabling auto-merge on pull requests",
		failure:     "pull request auto-merge failed",
		call: func(ctx context.Context, merger dashboard.PullRequestAutoMerger, owner, name string, number int) error {
			return merger.EnableAutoMerge(ctx, owner, name, number)
		},
	}

	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		if t.req.Forge == string(dashboard.ForgeForgejo) {
			armForgejoAutoMerge(w, r, deps, t)

			return
		}
		serveGuardedAction(w, r, deps, github, t)
	}
}

// armForgejoAutoMerge stores the user's intent to have this pull request
// merged once its checks pass. It never calls the forge. A pull request
// that is already armed is a 204, so a second click or a retry is harmless.
func armForgejoAutoMerge(w http.ResponseWriter, r *http.Request, deps Deps, t actionTarget) {
	forge := t.req.Forge

	intents, err := deps.SettingsStore.AutoMergeIntents(r.Context(), t.user.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("could not load auto-merge settings"))

		return
	}
	if _, armed := intents[settings.AutoMergeKey(forge, t.req.FullName, t.req.Number)]; armed {
		w.WriteHeader(http.StatusNoContent)

		return
	}
	if refuseIfNotAllowed(r.Context(), w, deps, t.user.ID, dashboard.ActionAutoMerge, forge, t.req.FullName, t.req.Number) {
		return
	}
	// Merging later needs a Forgejo token to merge with.
	if _, _, ok := forgeSource(w, r, deps, t.user.ID, forge); !ok {
		return
	}

	if err := deps.SettingsStore.ArmAutoMerge(r.Context(), t.user.ID, forge, t.req.FullName, t.req.Number); err != nil {
		slog.Warn("could not store auto-merge intent", "forge", forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
		writeJSON(w, http.StatusInternalServerError, errorBody("could not turn on auto-merge"))

		return
	}
	slog.Info("auto-merge armed", "forge", forge, "repo", t.req.FullName, "number", t.req.Number)
	w.WriteHeader(http.StatusNoContent)
}

// handlePullRequestAutoMergeCancel takes auto-merge back off. On Forgejo it
// cancels a merge scheduled on the forge (#1571) and removes the intent
// armForgejoAutoMerge stored. Cancelling is idempotent. On GitHub it turns the
// forge's own auto-merge off through dashboard.PullRequestAutoMergeDisabler
// (#1293), and only for a pull request that is armed.
func handlePullRequestAutoMergeCancel(deps Deps) http.HandlerFunc {
	github := guardedAction[dashboard.PullRequestAutoMergeDisabler]{
		allowed:     dashboard.ActionCancelAutoMerge,
		refusal:     dashboard.PullRequestActionCancelAutoMerge,
		unsupported: "doesn't support cancelling auto-merge on pull requests",
		failure:     "pull request auto-merge cancel failed",
		call: func(ctx context.Context, disabler dashboard.PullRequestAutoMergeDisabler, owner, name string, number int) error {
			return disabler.DisableAutoMerge(ctx, owner, name, number)
		},
	}

	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		if t.req.Forge == string(dashboard.ForgeGitHub) {
			serveGuardedAction(w, r, deps, github, t)

			return
		}
		if t.req.Forge != string(dashboard.ForgeForgejo) {
			writeJSON(w, http.StatusBadRequest, errorBody("unknown forge"))

			return
		}

		// A merge scheduled on the forge itself (#1571) is cancelled there too.
		// A source that can't cancel has nothing scheduled to cancel.
		src, _, ok := forgeSource(w, r, deps, t.user.ID, t.req.Forge)
		if !ok {
			return
		}
		if disabler, can := src.(dashboard.PullRequestAutoMergeDisabler); can {
			if err := disabler.DisableAutoMerge(r.Context(), t.owner, t.name, t.req.Number); err != nil {
				slog.Warn("forgejo auto-merge cancel failed", "repo", t.req.FullName, "number", t.req.Number, "error", err)
				writeActionRefusal(r.Context(), w, disabler, dashboard.PullRequestActionCancelAutoMerge, t.owner, t.name, t.req.Number, err)

				return
			}
		}

		if err := deps.SettingsStore.CancelAutoMerge(r.Context(), t.user.ID, t.req.Forge, t.req.FullName, t.req.Number); err != nil {
			slog.Warn("could not remove auto-merge intent", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody("could not cancel auto-merge"))

			return
		}
		slog.Info("auto-merge cancelled", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number)
		w.WriteHeader(http.StatusNoContent)
	}
}

// withAutoMergeIntent marks a Forgejo pull request as auto-merging when the
// user armed it here. The forge's own scheduled merge is already on the pull
// request, from the issue timeline (#1571).
func withAutoMergeIntent(pr dashboard.PullRequest, intents map[string]struct{}) dashboard.PullRequest {
	if pr.Forge != dashboard.ForgeForgejo {
		return pr
	}
	if _, armed := intents[settings.AutoMergeKey(string(pr.Forge), pr.Repo, pr.Number)]; armed {
		on := true
		pr.AutoMergeEnabled = &on
		pr.AutoMergeHeldBy = dashboard.AutoMergeHeldByDashboard
	}

	return pr
}
