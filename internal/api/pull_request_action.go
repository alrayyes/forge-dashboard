package api

import (
	"encoding/json"
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

	for _, src := range deps.BuildSources(userID, creds) {
		if string(src.Forge()) == forge {
			return src, creds, true
		}
	}
	writeJSON(w, http.StatusBadRequest, errorBody("no "+forge+" credentials saved"))

	return nil, settings.Credentials{}, false
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
