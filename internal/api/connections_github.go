package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/alrayyes/forge-dashboard/internal/oauth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// githubForge is the key of GitHub's row in the OAuth token store.
const githubForge = "github"

// handleGitHubConnectionStart answers POST /api/v1/connections/github.
func handleGitHubConnectionStart(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")

		if !deps.GitHubOAuth.Configured() {
			writeJSON(w, http.StatusBadRequest, errorBody("this server has no GitHub App OAuth client configured"))

			return
		}

		connected, err := deps.SettingsStore.HasOAuthToken(r.Context(), githubForge)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not read the connection"))

			return
		}

		if connected {
			writeJSON(w, http.StatusConflict, errorBody("a GitHub account is already connected; disconnect it first"))

			return
		}

		writeJSON(w, http.StatusOK, connectionAuthorizeResponse{AuthorizeURL: deps.GitHubOAuth.Begin()})
	}
}

// handleGitHubConnectionCallback answers GET /api/v1/connections/github/callback.
// Whatever goes wrong, the answer is fixed text: the query and GitHub's own
// error are never echoed, and nothing here logs a code or a token.
func handleGitHubConnectionCallback(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// The query holds a one-time code; no cache keeps it or the answer.
		w.Header().Set("Cache-Control", "no-store")

		if !deps.GitHubOAuth.Configured() {
			writeJSON(w, http.StatusBadRequest, errorBody("this server has no GitHub App OAuth client configured"))

			return
		}

		q := r.URL.Query()
		state, code := q.Get("state"), q.Get("code")

		switch {
		case q.Get("error") != "":
			writeJSON(w, http.StatusBadRequest, errorBody("the GitHub sign-in was not completed"))

			return
		case state == "" || code == "":
			writeJSON(w, http.StatusBadRequest, errorBody("the sign-in is missing its state or code"))

			return
		}

		if _, err := deps.GitHubOAuth.Finish(r.Context(), state, code); err != nil {
			writeGitHubFinishError(w, err)

			return
		}

		http.Redirect(w, r, settingsPath, http.StatusSeeOther)
	}
}

func writeGitHubFinishError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, oauth.ErrInvalidState):
		writeJSON(w, http.StatusBadRequest, errorBody("the sign-in is unknown, already used or expired; start again"))
	case errors.Is(err, oauth.ErrExchange):
		slog.Warn("github oauth: code exchange refused")
		writeJSON(w, http.StatusBadRequest, errorBody("GitHub refused the sign-in; start again"))
	case errors.Is(err, oauth.ErrAccount):
		slog.Warn("github oauth: could not read the account")
		writeJSON(w, http.StatusBadGateway, errorBody("GitHub granted access but would not say whose account it is"))
	default:
		slog.Warn("github oauth: could not store the token")
		writeJSON(w, http.StatusInternalServerError, errorBody("could not save the connection"))
	}
}

// handleGitHubConnectionDelete answers DELETE /api/v1/connections/github. It
// removes the user token pair and nothing else: installations, a pasted token
// and the other settings are untouched.
func handleGitHubConnectionDelete(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var err error
		if deps.GitHubOAuth != nil {
			err = deps.GitHubOAuth.Disconnect(r.Context())
		} else {
			// No OAuth client is configured any more, but a pair saved while
			// there was one still has to be removable.
			err = deps.SettingsStore.DeleteOAuthToken(r.Context(), githubForge)
		}

		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not disconnect"))

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// handleGitHubInstalled answers GET /api/v1/connections/github/installed, the
// App's Setup URL (#4575). GitHub sends the browser here after an install or a
// change of repository access, with installation_id and setup_action. The
// redirect is not trusted: the ID is stored only when it is in the connected
// user's own installations.
func handleGitHubInstalled(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")

		if !deps.GitHubOAuth.Configured() {
			writeJSON(w, http.StatusBadRequest, errorBody("this server has no GitHub App OAuth client configured"))

			return
		}

		id, err := strconv.ParseInt(r.URL.Query().Get("installation_id"), 10, 64)
		if err != nil || id <= 0 || id > maxInstallationID {
			writeJSON(w, http.StatusBadRequest, errorBody("the redirect carries no valid installation_id"))

			return
		}

		listed, err := deps.GitHubOAuth.UserInstallations(r.Context())
		if err != nil {
			writeGitHubInstalledError(w, err)

			return
		}

		for _, in := range listed {
			if in.ID != id {
				continue
			}

			if err := deps.SettingsStore.SaveInstallation(r.Context(), settings.Installation{ID: id, AccountLogin: in.AccountLogin}); err != nil {
				slog.Warn("github app: could not save the installation")
				writeJSON(w, http.StatusInternalServerError, errorBody("could not save the installation"))

				return
			}

			http.Redirect(w, r, settingsPath, http.StatusSeeOther)

			return
		}

		writeJSON(w, http.StatusForbidden, errorBody("that installation is not one of the connected account's"))
	}
}

func writeGitHubInstalledError(w http.ResponseWriter, err error) {
	if errors.Is(err, oauth.ErrNotConnected) {
		writeJSON(w, http.StatusConflict, errorBody("connect a GitHub account first"))

		return
	}

	slog.Warn("github app: could not list the user's installations")
	writeJSON(w, http.StatusBadGateway, errorBody("GitHub would not list the account's installations"))
}
