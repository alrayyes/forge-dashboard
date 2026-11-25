package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// forgejoForge is the key of Forgejo's row in the OAuth token store.
const forgejoForge = "forgejo"

// maxInstanceURLLen caps the instance URL a sign-in can start against.
const maxInstanceURLLen = 2048

// StartForgejoConnectionRequest matches components.schemas.StartForgejoConnectionRequest.
type startForgejoConnectionRequest struct {
	InstanceURL string `json:"instanceUrl"`
	ClientID    string `json:"clientId"`
}

// maxClientIDLen caps the Client ID an owner can name.
const maxClientIDLen = 256

// ConnectionAuthorizeResponse matches components.schemas.ConnectionAuthorizeResponse.
type connectionAuthorizeResponse struct {
	AuthorizeURL string `json:"authorizeUrl"`
}

// handleForgejoConnectionStart answers POST /api/v1/connections/forgejo.
func handleForgejoConnectionStart(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")

		var req startForgejoConnectionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("request body must be JSON with an instanceUrl"))

			return
		}

		clientID := strings.TrimSpace(req.ClientID)
		if len(clientID) > maxClientIDLen {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody("clientId", "clientId is too long"))

			return
		}

		// A Client ID the owner names wins; without one the server's own client
		// is used, and without that there is nothing to sign in with.
		if clientID == "" && !deps.ForgejoOAuth.Configured() {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody("clientId", "clientId is the Client ID of the app you created on your Forgejo"))

			return
		}

		raw := strings.TrimSpace(req.InstanceURL)
		if raw == "" || len(raw) > maxInstanceURLLen {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody("instanceUrl", "instanceUrl must be the address of your Forgejo"))

			return
		}

		if msg := forgejoURLProblem("instanceUrl", raw); msg != "" {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody("instanceUrl", msg))

			return
		}

		connected, err := deps.SettingsStore.HasOAuthToken(r.Context(), forgejoForge)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not read the connection"))

			return
		}

		if connected {
			writeJSON(w, http.StatusConflict, errorBody("a Forgejo account is already connected; disconnect it first"))

			return
		}

		if clientID != "" {
			writeJSON(w, http.StatusOK, connectionAuthorizeResponse{AuthorizeURL: deps.ForgejoOAuth.BeginPublic(raw, clientID)})

			return
		}

		writeJSON(w, http.StatusOK, connectionAuthorizeResponse{AuthorizeURL: deps.ForgejoOAuth.Begin(raw)})
	}
}

// handleForgejoConnectionCallback answers GET /api/v1/connections/forgejo/callback.
// Whatever goes wrong, the answer is fixed text: the query and the forge's own
// error are never echoed, and nothing here logs a code or a token.
func handleForgejoConnectionCallback(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// The query holds a one-time code; no cache keeps it or the answer.
		w.Header().Set("Cache-Control", "no-store")

		if deps.ForgejoOAuth == nil {
			writeJSON(w, http.StatusBadRequest, errorBody("this server cannot link a Forgejo account"))

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

		instance, account, err := deps.ForgejoOAuth.Finish(r.Context(), state, code)
		if err != nil {
			redirectSetupError(w, r, setupErrorFor("forgejo", err))

			return
		}

		creds, err := deps.SettingsStore.Get(r.Context())
		if err != nil && !errors.Is(err, settings.ErrNotFound) {
			undoConnection(r.Context(), deps)
			redirectSetupError(w, r, setupErrSaveFailed)

			return
		}

		// A pasted token was issued by the instance saved with it. Pointing the
		// settings at another one would pair that token with a host it was never
		// meant for, and send it there once the link is gone.
		if creds.ForgejoToken != "" && !sameInstance(creds.ForgejoURL, instance) {
			creds.ForgejoToken = ""
		}

		creds.ForgejoURL, creds.ForgejoUsername = instance, account
		if err := deps.SettingsStore.Set(r.Context(), creds); err != nil {
			undoConnection(r.Context(), deps)
			redirectSetupError(w, r, setupErrSaveFailed)

			return
		}

		deps.Service.Ensure(deps.AppContext, deps.BuildSources(creds))
		http.Redirect(w, r, setupPath, http.StatusSeeOther)
	}
}

// undoConnection removes a token pair whose companion settings didn't save, so
// the two never disagree.
func undoConnection(ctx context.Context, deps Deps) {
	if err := deps.ForgejoOAuth.Disconnect(ctx); err != nil {
		slog.Warn("forgejo oauth: could not undo a half-made connection")
	}
}

// handleForgejoConnectionDelete answers DELETE /api/v1/connections/forgejo.
func handleForgejoConnectionDelete(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var err error
		if deps.ForgejoOAuth != nil {
			err = deps.ForgejoOAuth.Disconnect(r.Context())
		} else {
			// No OAuth client is configured any more, but a pair saved while
			// there was one still has to be removable.
			err = deps.SettingsStore.DeleteOAuthToken(r.Context(), forgejoForge)
		}

		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not disconnect"))

			return
		}

		creds, err := deps.SettingsStore.Get(r.Context())
		if errors.Is(err, settings.ErrNotFound) {
			w.WriteHeader(http.StatusNoContent)

			return
		}

		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load existing settings"))

			return
		}

		// With a pasted token saved, the dashboard goes back to it and needs the
		// instance. Without one, the URL and name only belonged to the link.
		if !fallsBackToPastedToken(creds) {
			creds.ForgejoURL, creds.ForgejoUsername, creds.ForgejoToken = "", "", ""
			if err := deps.SettingsStore.Set(r.Context(), creds); err != nil {
				writeJSON(w, http.StatusInternalServerError, errorBody("could not save settings"))

				return
			}
		}

		deps.Service.Ensure(deps.AppContext, deps.BuildSources(creds))
		w.WriteHeader(http.StatusNoContent)
	}
}

// addOAuthStatus fills in the two OAuth fields of resp. It answers 500 itself
// and returns false when the store can't say.
func addOAuthStatus(ctx context.Context, w http.ResponseWriter, deps Deps, resp *SettingsResponse) bool {
	connected, err := deps.SettingsStore.HasOAuthToken(ctx, forgejoForge)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("could not read the connection"))

		return false
	}

	githubConnected, err := deps.SettingsStore.HasOAuthToken(ctx, githubForge)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("could not read the connection"))

		return false
	}

	resp.ForgejoOAuthConfigured = deps.ForgejoOAuth.Configured()
	resp.ForgejoOAuthConnected = connected
	resp.GitHubOAuthConfigured = deps.GitHubOAuth.Configured()
	resp.GitHubOAuthConnected = githubConnected

	return true
}

// keepsLinkedInstance answers 400 itself, and returns false, when a save would
// move a linked account's instance. The token belongs to the instance it was
// granted by; it must never be sent to another address.
func keepsLinkedInstance(ctx context.Context, w http.ResponseWriter, deps Deps, existing, merged settings.Credentials) bool {
	if merged.ForgejoURL == existing.ForgejoURL {
		return true
	}

	connected, err := deps.SettingsStore.HasOAuthToken(ctx, forgejoForge)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("could not read the connection"))

		return false
	}

	if connected {
		writeJSON(w, http.StatusBadRequest, fieldErrorBody("forgejoUrl", "forgejoUrl can't change while a Forgejo account is connected; disconnect it first"))

		return false
	}

	return true
}

// disconnectKeepsPastedToken is whether unlinking an account leaves a pasted
// token in use (ticket #3951's fifth criterion). The one place to change if the
// owner decides there is no fallback: false makes Disconnect clear the token
// along with the URL and name.
const disconnectKeepsPastedToken = true

func fallsBackToPastedToken(creds settings.Credentials) bool {
	return disconnectKeepsPastedToken && creds.ForgejoToken != ""
}

// sameInstance compares two instance addresses the way the OAuth code stores
// them, without a trailing slash.
func sameInstance(a, b string) bool {
	return strings.TrimSuffix(a, "/") == strings.TrimSuffix(b, "/")
}
