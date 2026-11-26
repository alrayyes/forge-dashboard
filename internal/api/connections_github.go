package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
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
			redirectSetupError(w, r, setupErrAccessDenied)

			return
		case state == "" || code == "":
			redirectSetupError(w, r, setupErrInvalidState)

			return
		}

		if _, err := deps.GitHubOAuth.Finish(r.Context(), state, code); err != nil {
			redirectSetupError(w, r, setupErrorFor("github", err))

			return
		}

		rebuildGitHubSources(r.Context(), deps)
		http.Redirect(w, r, setupPath, http.StatusSeeOther)
	}
}

// rebuildGitHubSources swaps the running sources for ones built after a link
// or an unlink. Which credential reads is chosen when the sources are built, so
// without this the running source keeps the old one until the next settings
// save or restart. Nothing saved reads as empty settings: a linked account can
// read with no other setting.
func rebuildGitHubSources(ctx context.Context, deps Deps) {
	deps.Service.EnsureFrom(deps.AppContext, func() ([]dashboard.Source, bool) {
		creds, err := deps.SettingsStore.Get(ctx)
		if err != nil && !errors.Is(err, settings.ErrNotFound) {
			return nil, false
		}

		return deps.BuildSources(creds), true
	})
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

		rebuildGitHubSources(r.Context(), deps)
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
			redirectSetupError(w, r, setupErrNotConnected)

			return
		}

		// An owner who may not install the App asks the organisation's owners
		// to. GitHub still sends the browser back, with no installation yet.
		if r.URL.Query().Get("installation_id") == "" && r.URL.Query().Get("setup_action") == "request" {
			http.Redirect(w, r, setupPath+"?install=requested", http.StatusSeeOther)

			return
		}

		id, err := strconv.ParseInt(r.URL.Query().Get("installation_id"), 10, 64)
		if err != nil || id <= 0 || id > maxInstallationID {
			redirectSetupError(w, r, setupErrInstallationUnverified)

			return
		}

		listed, err := deps.GitHubOAuth.UserInstallations(r.Context())
		if err != nil {
			redirectGitHubInstalledError(w, r, err)

			return
		}

		login, found := installationLogin(listed, id)
		if !found {
			redirectSetupError(w, r, setupErrInstallationUnverified)

			return
		}

		if err := deps.SettingsStore.SaveInstallation(r.Context(), settings.Installation{ID: id, AccountLogin: login}); err != nil {
			slog.Warn("github app: could not save the installation")
			redirectSetupError(w, r, setupErrSaveFailed)

			return
		}

		http.Redirect(w, r, setupPath, http.StatusSeeOther)
	}
}

func installationLogin(listed []oauth.UserInstallation, id int64) (string, bool) {
	for _, in := range listed {
		if in.ID == id {
			return in.AccountLogin, true
		}
	}

	return "", false
}

func redirectGitHubInstalledError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, oauth.ErrNotConnected) {
		redirectSetupError(w, r, setupErrNotConnected)

		return
	}

	slog.Warn("github app: could not list the user's installations")
	redirectSetupError(w, r, setupErrInstallationsUnavailable)
}
