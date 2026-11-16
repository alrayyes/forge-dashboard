package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// autoMergeAdapter is how one kind of forge arms and cancels auto-merge. Which
// one a forge gets is its capability (AutoMergeHeldByApp), never its name.
type autoMergeAdapter interface {
	arm(w http.ResponseWriter, r *http.Request, deps Deps, t actionTarget)
	cancel(w http.ResponseWriter, r *http.Request, deps Deps, t actionTarget)
}

// autoMergeAdapterFor picks the adapter for forge. known is false for a forge
// this build has no capabilities for: it gets the forge-held adapter, which
// the forge lookup then refuses, and cancel answers 400.
func autoMergeAdapterFor(forge string) (adapter autoMergeAdapter, known bool) {
	c, known := dashboard.CapabilitiesOf(dashboard.Forge(forge))
	if known && c.AutoMergeHeldByApp {
		return appHeldAutoMerge{}, true
	}

	return newForgeHeldAutoMerge(), known
}

// handlePullRequestAutoMerge arms auto-merge on the named pull request. Where
// the forge holds it (GitHub) that is the forge's own native auto-merge, which
// dashboard.PullRequestAutoMerger's EnableAutoMerge decides how to switch on.
// Where the app holds it (Forgejo) it is this app's own intent: the background
// pass merges it once checks pass. A merge scheduled on Forgejo itself is read
// from the timeline.
func handlePullRequestAutoMerge(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		adapter, _ := autoMergeAdapterFor(t.req.Forge)
		adapter.arm(w, r, deps, t)
	}
}

// forgeHeldAutoMerge arms and cancels through the forge's own auto-merge.
type forgeHeldAutoMerge struct {
	enable  guardedAction[dashboard.PullRequestAutoMerger]
	disable guardedAction[dashboard.PullRequestAutoMergeDisabler]
}

func newForgeHeldAutoMerge() forgeHeldAutoMerge {
	return forgeHeldAutoMerge{
		enable: guardedAction[dashboard.PullRequestAutoMerger]{
			allowed:     dashboard.ActionAutoMerge,
			refusal:     dashboard.PullRequestActionAutoMerge,
			unsupported: "doesn't support enabling auto-merge on pull requests",
			failure:     "pull request auto-merge failed",
			call: func(ctx context.Context, merger dashboard.PullRequestAutoMerger, owner, name string, number int) error {
				return merger.EnableAutoMerge(ctx, owner, name, number)
			},
		},
		disable: guardedAction[dashboard.PullRequestAutoMergeDisabler]{
			allowed:     dashboard.ActionCancelAutoMerge,
			refusal:     dashboard.PullRequestActionCancelAutoMerge,
			unsupported: "doesn't support cancelling auto-merge on pull requests",
			failure:     "pull request auto-merge cancel failed",
			call: func(ctx context.Context, disabler dashboard.PullRequestAutoMergeDisabler, owner, name string, number int) error {
				return disabler.DisableAutoMerge(ctx, owner, name, number)
			},
		},
	}
}

func (f forgeHeldAutoMerge) arm(w http.ResponseWriter, r *http.Request, deps Deps, t actionTarget) {
	serveGuardedAction(w, r, deps, f.enable, t)
}

func (f forgeHeldAutoMerge) cancel(w http.ResponseWriter, r *http.Request, deps Deps, t actionTarget) {
	serveGuardedAction(w, r, deps, f.disable, t)
}

// appHeldAutoMerge arms and cancels this app's own intent.
type appHeldAutoMerge struct{}

func (appHeldAutoMerge) arm(w http.ResponseWriter, r *http.Request, deps Deps, t actionTarget) {
	armAppHeldAutoMerge(w, r, deps, t)
}

// armAppHeldAutoMerge stores the user's intent to have this pull request
// merged once its checks pass. It never calls the forge. A pull request
// that is already armed is a 204, so a second click or a retry is harmless.
func armAppHeldAutoMerge(w http.ResponseWriter, r *http.Request, deps Deps, t actionTarget) {
	forge := t.req.Forge

	intents, err := deps.SettingsStore.AutoMergeIntents(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("could not load auto-merge settings"))

		return
	}
	if _, armed := intents[settings.AutoMergeKey(forge, t.req.FullName, t.req.Number)]; armed {
		w.WriteHeader(http.StatusNoContent)

		return
	}
	if refuseIfNotAllowed(r.Context(), w, deps, dashboard.ActionAutoMerge, forge, t.req.FullName, t.req.Number) {
		return
	}
	// Merging later needs a Forgejo token to merge with.
	if _, _, ok := forgeSource(w, r, deps, forge); !ok {
		return
	}

	if err := deps.SettingsStore.ArmAutoMerge(r.Context(), forge, t.req.FullName, t.req.Number); err != nil {
		slog.Warn("could not store auto-merge intent", "forge", forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
		writeJSON(w, http.StatusInternalServerError, errorBody("could not turn on auto-merge"))

		return
	}
	slog.Info("auto-merge armed", "forge", forge, "repo", t.req.FullName, "number", t.req.Number)
	w.WriteHeader(http.StatusNoContent)
}

// handlePullRequestAutoMergeCancel takes auto-merge back off. Where the app
// holds it (Forgejo) it cancels a merge scheduled on the forge (#1571) and
// removes the intent armAppHeldAutoMerge stored. Cancelling is idempotent.
// Where the forge holds it (GitHub) it turns the forge's own auto-merge off
// through dashboard.PullRequestAutoMergeDisabler (#1293), and only for a pull
// request that is armed.
func handlePullRequestAutoMergeCancel(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		adapter, known := autoMergeAdapterFor(t.req.Forge)
		if !known {
			writeJSON(w, http.StatusBadRequest, errorBody("unknown forge"))

			return
		}
		adapter.cancel(w, r, deps, t)
	}
}

func (appHeldAutoMerge) cancel(w http.ResponseWriter, r *http.Request, deps Deps, t actionTarget) {
	// A merge scheduled on the forge itself (#1571) is cancelled there too.
	// A source that can't cancel has nothing scheduled to cancel.
	src, _, ok := forgeSource(w, r, deps, t.req.Forge)
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

	if err := deps.SettingsStore.CancelAutoMerge(r.Context(), t.req.Forge, t.req.FullName, t.req.Number); err != nil {
		slog.Warn("could not remove auto-merge intent", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
		writeJSON(w, http.StatusInternalServerError, errorBody("could not cancel auto-merge"))

		return
	}
	slog.Info("auto-merge cancelled", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number)
	w.WriteHeader(http.StatusNoContent)
}

// withAutoMergeIntent marks an app-held pull request as auto-merging when the
// user armed it here. The forge's own scheduled merge is already on the pull
// request, from the issue timeline (#1571).
func withAutoMergeIntent(pr dashboard.PullRequest, intents map[string]struct{}) dashboard.PullRequest {
	if !appHoldsAutoMerge(pr.Forge) {
		return pr
	}
	if _, armed := intents[settings.AutoMergeKey(string(pr.Forge), pr.Repo, pr.Number)]; armed {
		on := true
		pr.AutoMergeEnabled = &on
		pr.AutoMergeHeldBy = dashboard.AutoMergeHeldByDashboard
	}

	return pr
}
