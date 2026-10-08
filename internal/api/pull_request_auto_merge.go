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
// On Forgejo it is this app's own intent, because Forgejo's scheduled merge
// can't be read back: the background pass merges it once checks pass.
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

// handlePullRequestAutoMergeCancel removes the intent armForgejoAutoMerge
// stored. Forgejo only, and it never calls the forge: the intent lives here.
// Idempotent.
func handlePullRequestAutoMergeCancel(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		if t.req.Forge != string(dashboard.ForgeForgejo) {
			writeJSON(w, http.StatusBadRequest, errorBody("only Forgejo auto-merge is cancelled from here"))

			return
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
// user armed it here. Forgejo can't say so itself.
func withAutoMergeIntent(pr dashboard.PullRequest, intents map[string]struct{}) dashboard.PullRequest {
	if pr.Forge != dashboard.ForgeForgejo {
		return pr
	}
	if _, armed := intents[settings.AutoMergeKey(string(pr.Forge), pr.Repo, pr.Number)]; armed {
		on := true
		pr.AutoMergeEnabled = &on
	}

	return pr
}
