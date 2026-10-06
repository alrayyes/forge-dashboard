package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// The pull request write endpoints (merge, close, auto-merge, update branch and
// the two bots' commands) all start the same way: who is asking, which pull
// request, which of the user's forges. These helpers hold that, so each
// handler is the part that differs. The order is the one every handler had:
// the caller, then the body, then the repo name, and only then the forge.

// actionTarget is the pull request a write endpoint was asked to act on, once
// its caller and body have been read.
type actionTarget struct {
	user        *auth.User
	req         pullRequestActionRequest
	owner, name string
}

// readActionTarget reads who is asking and which pull request, and answers 500
// or 400 itself when it can't.
func readActionTarget(w http.ResponseWriter, r *http.Request) (actionTarget, bool) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

		return actionTarget{}, false
	}

	var req pullRequestActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

		return actionTarget{}, false
	}

	if overBound(w, bound{"fullName", req.FullName, maxRepoFullNameLen}) {
		return actionTarget{}, false
	}
	if req.Number > maxPullRequestNumber {
		writeJSON(w, http.StatusBadRequest, fieldErrorBody("number", "number is too large"))

		return actionTarget{}, false
	}

	owner, name, ok := splitFullName(req.FullName)
	if !ok {
		writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

		return actionTarget{}, false
	}

	return actionTarget{user: u, req: req, owner: owner, name: name}, true
}

// forgeSource finds the signed-in user's source for forge, with the settings it
// was built from, and answers 500 or 400 itself when it can't.
func forgeSource(w http.ResponseWriter, r *http.Request, deps Deps, userID []byte, forge string) (dashboard.Source, settings.Credentials, bool) {
	creds, err := deps.SettingsStore.Get(r.Context(), userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("could not load settings"))

		return nil, settings.Credentials{}, false
	}

	src, ok := findForgeSource(w, deps, userID, creds, forge)

	return src, creds, ok
}

// findForgeSource picks the source for forge out of the ones creds builds, and
// answers 400 itself when the user has none. It is forgeSource's second half,
// for a handler that has to do something between loading the settings and
// looking for the source.
func findForgeSource(w http.ResponseWriter, deps Deps, userID []byte, creds settings.Credentials, forge string) (dashboard.Source, bool) {
	for _, src := range deps.BuildSources(userID, creds) {
		if string(src.Forge()) == forge {
			return src, true
		}
	}
	writeJSON(w, http.StatusBadRequest, errorBody("no "+forge+" credentials saved"))

	return nil, false
}

// capabilityOf asks src for the one optional capability a handler needs, and
// answers 400 with unsupported (what the forge can't do) when it lacks it.
func capabilityOf[T any](w http.ResponseWriter, src dashboard.Source, forge, unsupported string) (T, bool) {
	capability, ok := src.(T)
	if !ok {
		writeJSON(w, http.StatusBadRequest, errorBody(forge+" "+unsupported))

		var none T

		return none, false
	}

	return capability, true
}

// guardedAction describes a pull request write whose whole job is one call on
// one optional forge capability: the server's own allowed-actions guard, then
// the forge, then 204. Auto-merge and rerunning checks are two of them.
type guardedAction[T any] struct {
	// allowed is the entry in the pull request's allowedActions that offers it.
	allowed dashboard.ActionName
	// refusal names it for the refusal classifier.
	refusal dashboard.PullRequestAction
	// unsupported is what a forge without the capability can't do, for the 400.
	unsupported string
	// failure is the log line when the forge refuses.
	failure string
	call    func(ctx context.Context, capability T, owner, name string, number int) error
}

// handleGuardedAction serves a guardedAction.
func handleGuardedAction[T any](deps Deps, a guardedAction[T]) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		serveGuardedAction(w, r, deps, a, t)
	}
}

// serveGuardedAction is handleGuardedAction once the target is read, for a
// handler that sends some forges elsewhere first.
func serveGuardedAction[T any](w http.ResponseWriter, r *http.Request, deps Deps, a guardedAction[T], t actionTarget) {
	if refuseIfNotAllowed(w, deps, t.user.ID, a.allowed, t.req.Forge, t.req.FullName, t.req.Number) {
		return
	}
	src, _, ok := forgeSource(w, r, deps, t.user.ID, t.req.Forge)
	if !ok {
		return
	}
	capability, ok := capabilityOf[T](w, src, t.req.Forge, a.unsupported)
	if !ok {
		return
	}

	if err := a.call(r.Context(), capability, t.owner, t.name, t.req.Number); err != nil {
		slog.Warn(a.failure, "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
		writeActionRefusal(r.Context(), w, capability, a.refusal, t.owner, t.name, t.req.Number, err)

		return
	}

	w.WriteHeader(http.StatusNoContent)
}
