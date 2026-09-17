package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// SettingsResponse matches components.schemas.SettingsResponse in
// api/openapi.yaml. Tokens are never sent back to the browser once
// saved — *Set reports whether one is on file, not what it is.
type SettingsResponse struct {
	GitHubUsername  string `json:"githubUsername"`
	GitHubTokenSet  bool   `json:"githubTokenSet"`
	ForgejoURL      string `json:"forgejoUrl"`
	ForgejoUsername string `json:"forgejoUsername"`
	ForgejoTokenSet bool   `json:"forgejoTokenSet"`
	// WebhookToken and WebhookSecret, unlike the forge tokens above, are
	// ours to hand back in the clear — the user has to paste them into
	// the forge's own webhook setup, so a "set" flag alone wouldn't do.
	WebhookToken  string `json:"webhookToken"`
	WebhookSecret string `json:"webhookSecret"`
	// AllowBotPrUpdates and RenovateRebaseLabel — see settings.Credentials'
	// own doc comments; both round-trip as plain values, unlike the forge
	// tokens above, since neither is a secret.
	AllowBotPrUpdates   bool   `json:"allowBotPrUpdates"`
	RenovateRebaseLabel string `json:"renovateRebaseLabel"`
}

func settingsResponseOf(c settings.Credentials) SettingsResponse {
	return SettingsResponse{
		GitHubUsername:      c.GitHubUsername,
		GitHubTokenSet:      c.GitHubToken != "",
		ForgejoURL:          c.ForgejoURL,
		ForgejoUsername:     c.ForgejoUsername,
		ForgejoTokenSet:     c.ForgejoToken != "",
		WebhookToken:        c.WebhookToken,
		WebhookSecret:       c.WebhookSecret,
		AllowBotPrUpdates:   c.AllowBotPrUpdates,
		RenovateRebaseLabel: c.RenovateRebaseLabel,
	}
}

func handleSettingsGet(store *settings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))
			return
		}

		creds, err := store.Get(r.Context(), u.ID)
		if err != nil && !errors.Is(err, settings.ErrNotFound) {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load settings"))
			return
		}

		// Every visit to Settings is a webhook credentials' first chance
		// to exist — a user who never saved GitHub/Forgejo settings at
		// all still needs a webhook URL to paste into their forge.
		creds.WebhookToken, creds.WebhookSecret, err = store.EnsureWebhookCredentials(r.Context(), u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load webhook credentials"))
			return
		}

		writeJSON(w, http.StatusOK, settingsResponseOf(creds))
	}
}

// settingsPutRequest matches components.schemas.SettingsRequest. A blank
// token field means "leave the saved one alone" — the only way a secret
// field can behave once the browser can't be shown what's already saved.
// Every other field is a plain replace: an intentionally blanked
// GitHubUsername, say, really does clear it.
type settingsPutRequest struct {
	GitHubToken         string `json:"githubToken"`
	GitHubUsername      string `json:"githubUsername"`
	ForgejoURL          string `json:"forgejoUrl"`
	ForgejoToken        string `json:"forgejoToken"`
	ForgejoUsername     string `json:"forgejoUsername"`
	AllowBotPrUpdates   bool   `json:"allowBotPrUpdates"`
	RenovateRebaseLabel string `json:"renovateRebaseLabel"`
}

func handleSettingsPut(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))
			return
		}

		var req settingsPutRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
			return
		}

		existing, err := deps.SettingsStore.Get(r.Context(), u.ID)
		if err != nil && !errors.Is(err, settings.ErrNotFound) {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load existing settings"))
			return
		}

		merged := settings.Credentials{
			GitHubToken:         coalesce(req.GitHubToken, existing.GitHubToken),
			GitHubUsername:      req.GitHubUsername,
			ForgejoURL:          req.ForgejoURL,
			ForgejoToken:        coalesce(req.ForgejoToken, existing.ForgejoToken),
			ForgejoUsername:     req.ForgejoUsername,
			AllowBotPrUpdates:   req.AllowBotPrUpdates,
			RenovateRebaseLabel: req.RenovateRebaseLabel,
			// Set doesn't touch these columns (see settings.Store.Set) —
			// carried over here only so this response reflects them
			// too, rather than reporting them blank until the next GET.
			WebhookToken:  existing.WebhookToken,
			WebhookSecret: existing.WebhookSecret,
		}

		// buildSourcesForUser skips Forgejo entirely once ForgejoURL is
		// empty, token or username notwithstanding — so a token/username
		// saved without a URL wouldn't just be incomplete, it'd silently
		// do nothing.
		if merged.ForgejoURL == "" && (merged.ForgejoToken != "" || merged.ForgejoUsername != "") {
			writeJSON(w, http.StatusBadRequest, errorBody("forgejoUrl is required when a Forgejo token or username is set"))
			return
		}

		if err := deps.SettingsStore.Set(r.Context(), u.ID, merged); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save settings"))
			return
		}

		// deps.AppContext: see the identical comment in auth.go's
		// startSession — this background refresh loop has to outlive the
		// request that started it.
		deps.Manager.Ensure(deps.AppContext, u.ID, deps.BuildSources(merged))

		writeJSON(w, http.StatusOK, settingsResponseOf(merged))
	}
}

func coalesce(newValue, existingValue string) string {
	if newValue != "" {
		return newValue
	}
	return existingValue
}
