package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// SettingsResponse matches components.schemas.SettingsResponse in
// api/openapi.yaml. Tokens are never sent back to the browser once
// saved — *Set reports whether one is on file, not what it is.
type SettingsResponse struct {
	GitHubUsername string `json:"githubUsername"`
	GitHubTokenSet bool   `json:"githubTokenSet"`
	// GitHubAppInstallationID and GitHubAppConfigured (#620) — see their
	// SettingsResponse doc comments in api/openapi.yaml for the full
	// precedence/validation story.
	GitHubAppInstallationID int64  `json:"githubAppInstallationId"`
	GitHubAppConfigured     bool   `json:"githubAppConfigured"`
	ForgejoURL              string `json:"forgejoUrl"`
	ForgejoUsername         string `json:"forgejoUsername"`
	ForgejoTokenSet         bool   `json:"forgejoTokenSet"`
	// WebhookToken and WebhookSecret, unlike the forge tokens above, are
	// ours to hand back in the clear — the user has to paste them into
	// the forge's own webhook setup, so a "set" flag alone wouldn't do.
	WebhookToken  string `json:"webhookToken"`
	WebhookSecret string `json:"webhookSecret"`
	// RenovateRebaseLabel — see settings.Credentials' own doc comment;
	// round-trips as a plain value, unlike the forge tokens above, since
	// it isn't a secret.
	RenovateRebaseLabel string `json:"renovateRebaseLabel"`
	// RenovateAuthors — see settings.Credentials' own doc comment. Always a
	// list on the wire, never null.
	RenovateAuthors []string `json:"renovateAuthors"`
	// Theme — see settings.Credentials' own doc comment. Round-tripped
	// here too so the Settings page's own save confirms what it just set,
	// even though the lightweight GET /api/settings/theme below is what
	// every other page actually polls on load.
	Theme string `json:"theme"`
	// Timezone — see settings.Credentials' own doc comment. Round-tripped
	// here so the Settings page shows what is saved; every other page reads
	// the lightweight GET /api/settings/timezone.
	Timezone string `json:"timezone"`
}

func settingsResponseOf(c settings.Credentials, githubAppConfigured bool) SettingsResponse {
	return SettingsResponse{
		GitHubUsername:          c.GitHubUsername,
		GitHubTokenSet:          c.GitHubToken != "",
		GitHubAppInstallationID: c.GitHubAppInstallationID,
		GitHubAppConfigured:     githubAppConfigured,
		ForgejoURL:              c.ForgejoURL,
		ForgejoUsername:         c.ForgejoUsername,
		ForgejoTokenSet:         c.ForgejoToken != "",
		WebhookToken:            c.WebhookToken,
		WebhookSecret:           c.WebhookSecret,
		RenovateRebaseLabel:     c.RenovateRebaseLabel,
		RenovateAuthors:         append([]string{}, c.RenovateAuthors...),
		Theme:                   c.Theme,
		Timezone:                c.Timezone,
	}
}

// ThemeResponse matches components.schemas.ThemeResponse. Every page needs
// this on load, and none of them should trigger EnsureWebhookCredentials
// just to read one field — the same reasoning that gave Theme its own
// dedicated GET rather than folding it into handleSettingsGet.
type ThemeResponse struct {
	Theme string `json:"theme"`
}

func handleThemeGet(store *settings.Store) http.HandlerFunc {
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
		// ErrNotFound leaves creds at its zero value — Theme "" (system),
		// the same default a user who has saved settings but never
		// touched this control gets from settings.Store.Get itself.

		writeJSON(w, http.StatusOK, ThemeResponse{Theme: creds.Theme})
	}
}

// themePutRequest matches components.schemas.ThemeRequest.
type themePutRequest struct {
	Theme string `json:"theme"`
}

// handleThemePut is Settings' own dedicated, instant save for the Theme
// control (#352) — deliberately not routed through the main
// PUT /api/settings, whose every other field is a plain replace rather
// than a per-field merge (see settingsPutRequest's own doc comment): a
// request carrying only {"theme":"dark"} through that handler would blank
// every other saved field. Picking a theme should apply immediately, the
// same "set once and forget" convention the ticket's own research cites,
// not wait on the rest of the form's own Save button.
func handleThemePut(store *settings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		var req themePutRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}
		if req.Theme != "" && req.Theme != "light" && req.Theme != "dark" {
			writeJSON(w, http.StatusBadRequest, errorBody(`theme must be "", "light", or "dark"`))

			return
		}

		existing, err := store.Get(r.Context(), u.ID)
		if err != nil && !errors.Is(err, settings.ErrNotFound) {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load existing settings"))

			return
		}
		existing.Theme = req.Theme

		if err := store.Set(r.Context(), u.ID, existing); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save theme"))

			return
		}

		writeJSON(w, http.StatusOK, ThemeResponse{Theme: existing.Theme})
	}
}

func handleSettingsGet(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		creds, err := deps.SettingsStore.Get(r.Context(), u.ID)
		if err != nil && !errors.Is(err, settings.ErrNotFound) {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load settings"))

			return
		}

		// Every visit to Settings is a webhook credentials' first chance
		// to exist — a user who never saved GitHub/Forgejo settings at
		// all still needs a webhook URL to paste into their forge.
		creds.WebhookToken, creds.WebhookSecret, err = deps.SettingsStore.EnsureWebhookCredentials(r.Context(), u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load webhook credentials"))

			return
		}

		writeJSON(w, http.StatusOK, settingsResponseOf(creds, deps.GitHubAppConfigured))
	}
}

// settingsPutRequest matches components.schemas.SettingsRequest. A blank
// token field means "leave the saved one alone" — the only way a secret
// field can behave once the browser can't be shown what's already saved.
// Every other field is a plain replace: an intentionally blanked
// GitHubUsername, say, really does clear it.
type settingsPutRequest struct {
	GitHubToken    string `json:"githubToken"`
	GitHubUsername string `json:"githubUsername"`
	// GitHubAppInstallationID (#620) is a plain replace like
	// GitHubUsername, not coalesced like the token fields — 0 or omitted
	// really does disconnect the App. See handleSettingsPut's own
	// validation for why a non-zero value needs deps.GitHubAppConfigured.
	GitHubAppInstallationID int64  `json:"githubAppInstallationId"`
	ForgejoURL              string `json:"forgejoUrl"`
	ForgejoToken            string `json:"forgejoToken"`
	ForgejoUsername         string `json:"forgejoUsername"`
	RenovateRebaseLabel     string `json:"renovateRebaseLabel"`
	// RenovateAuthors replaces the saved list. Omitted or empty clears it.
	RenovateAuthors []string `json:"renovateAuthors"`
}

// cleanLogins trims the logins, drops blanks and repeats (a forge login isn't
// case sensitive), and answers whether the list is acceptable. A login holds
// no comma, which is what the store joins on.
func cleanLogins(w http.ResponseWriter, logins []string) ([]string, bool) {
	if len(logins) > maxRenovateAuthors {
		writeJSON(w, http.StatusBadRequest, fieldErrorBody("renovateAuthors", "renovateAuthors lists too many logins"))

		return nil, false
	}

	var out []string
	seen := map[string]struct{}{}
	for _, l := range logins {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		if strings.Contains(l, ",") || utf8.RuneCountInString(l) > maxUsernameLen {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody("renovateAuthors", "renovateAuthors holds one login per entry"))

			return nil, false
		}
		if _, dup := seen[strings.ToLower(l)]; dup {
			continue
		}
		seen[strings.ToLower(l)] = struct{}{}
		out = append(out, l)
	}

	return out, true
}

// decodeSettingsPut reads the body, and answers 400 itself when it can't. A
// value of the wrong type names its field, so a client can mark that input
// (#810).
func decodeSettingsPut(w http.ResponseWriter, r *http.Request) (settingsPutRequest, bool) {
	var req settingsPutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		if typeErr, ok := errors.AsType[*json.UnmarshalTypeError](err); ok && typeErr.Field != "" {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody(typeErr.Field, typeErr.Field+" must be "+typeInWords(typeErr.Type)))

			return settingsPutRequest{}, false
		}
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

		return settingsPutRequest{}, false
	}
	if overBound(w,
		bound{"githubToken", req.GitHubToken, maxForgeTokenLen},
		bound{"githubUsername", req.GitHubUsername, maxUsernameLen},
		bound{"forgejoUrl", req.ForgejoURL, maxForgeURLLen},
		bound{"forgejoToken", req.ForgejoToken, maxForgeTokenLen},
		bound{"forgejoUsername", req.ForgejoUsername, maxUsernameLen},
		bound{"renovateRebaseLabel", req.RenovateRebaseLabel, maxLabelLen}) {
		return settingsPutRequest{}, false
	}
	var ok bool
	if req.RenovateAuthors, ok = cleanLogins(w, req.RenovateAuthors); !ok {
		return settingsPutRequest{}, false
	}

	return req, true
}

// mergeSettings is what Set is given: the request's fields, with a blank token
// left as it was.
func mergeSettings(req settingsPutRequest, existing settings.Credentials) settings.Credentials {
	return settings.Credentials{
		GitHubToken:             coalesce(req.GitHubToken, existing.GitHubToken),
		GitHubUsername:          req.GitHubUsername,
		GitHubAppInstallationID: req.GitHubAppInstallationID,
		ForgejoURL:              req.ForgejoURL,
		ForgejoToken:            coalesce(req.ForgejoToken, existing.ForgejoToken),
		ForgejoUsername:         req.ForgejoUsername,
		RenovateRebaseLabel:     req.RenovateRebaseLabel,
		RenovateAuthors:         req.RenovateAuthors,
		// Theme isn't part of this request at all — it has its own
		// dedicated PUT /api/settings/theme (handleThemePut) so
		// picking it applies and saves instantly rather than
		// waiting on this form's Save button. Carried over
		// untouched here for the same reason WebhookToken/
		// WebhookSecret are below: Store.Set writes every column
		// on every call, so leaving Theme out of this struct
		// would silently reset it to "" on every ordinary save.
		Theme: existing.Theme,
		// Same for the timezone and PUT /api/settings/timezone (#996).
		Timezone: existing.Timezone,
		// Set doesn't touch these columns (see settings.Store.Set) —
		// carried over here only so this response reflects them
		// too, rather than reporting them blank until the next GET.
		WebhookToken:  existing.WebhookToken,
		WebhookSecret: existing.WebhookSecret,
	}
}

// settingsFieldError says which field of merged can never work, and why, or
// returns an empty field when all of it can.
func settingsFieldError(merged settings.Credentials, req settingsPutRequest, githubAppConfigured bool) (field, message string) {
	switch {
	case merged.ForgejoURL == "" && (merged.ForgejoToken != "" || merged.ForgejoUsername != ""):
		// buildSourcesForUser skips Forgejo entirely once ForgejoURL is
		// empty, token or username notwithstanding — so a token/username
		// saved without a URL wouldn't just be incomplete, it'd silently
		// do nothing.
		return "forgejoUrl", "forgejoUrl is required when a Forgejo token or username is set"
	case req.GitHubAppInstallationID < 0:
		return "githubAppInstallationId", "githubAppInstallationId must be positive"
	case req.GitHubAppInstallationID > maxInstallationID:
		return "githubAppInstallationId", "githubAppInstallationId is too large"
	case merged.GitHubAppInstallationID != 0 && !githubAppConfigured:
		// #620: a saved installation ID this server can never actually
		// exercise (no GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_BASE64
		// configured) is worse than an error at save time — the same
		// "this can never work" reasoning as the Forgejo-URL check above.
		return "githubAppInstallationId", "this server has no GitHub App configured; githubAppInstallationId cannot be set"
	}

	return "", ""
}

func handleSettingsPut(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		req, ok := decodeSettingsPut(w, r)
		if !ok {
			return
		}

		existing, err := deps.SettingsStore.Get(r.Context(), u.ID)
		if err != nil && !errors.Is(err, settings.ErrNotFound) {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load existing settings"))

			return
		}

		merged := mergeSettings(req, existing)
		if field, message := settingsFieldError(merged, req, deps.GitHubAppConfigured); field != "" {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody(field, message))

			return
		}

		if err := deps.SettingsStore.Set(r.Context(), u.ID, merged); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save settings"))

			return
		}

		// deps.AppContext: see the identical comment in auth.go's
		// startSession — this background refresh loop has to outlive the
		// request that started it.
		deps.Manager.Ensure(deps.AppContext, u.ID, deps.BuildSources(u.ID, merged))

		writeJSON(w, http.StatusOK, settingsResponseOf(merged, deps.GitHubAppConfigured))
	}
}

func coalesce(newValue, existingValue string) string {
	if newValue != "" {
		return newValue
	}

	return existingValue
}

// typeInWords names a Go type the way a person would say what a field must
// be, so an error reads "must be a whole number", not "must be a int64".
func typeInWords(t reflect.Type) string {
	switch t.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "a whole number"
	case reflect.Float32, reflect.Float64:
		return "a number"
	case reflect.Bool:
		return "true or false"
	case reflect.String:
		return "text"
	default:
		return "a " + t.String()
	}
}

// TimezoneResponse matches components.schemas.TimezoneResponse. Every page
// needs it on load to show times in the user's zone, so it has its own cheap
// GET like Theme does.
type TimezoneResponse struct {
	Timezone string `json:"timezone"`
}

func handleTimezoneGet(store *settings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		// ErrNotFound leaves creds at its zero value: Timezone "" (the browser's own).
		creds, err := store.Get(r.Context(), u.ID)
		if err != nil && !errors.Is(err, settings.ErrNotFound) {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load settings"))

			return
		}

		writeJSON(w, http.StatusOK, TimezoneResponse{Timezone: creds.Timezone})
	}
}

// timezonePutRequest matches components.schemas.TimezoneRequest.
type timezonePutRequest struct {
	Timezone string `json:"timezone"`
}

// validTimezone reports whether name is empty (the browser's zone) or an IANA
// zone name. "Local" is refused: it means this server's zone, not the user's.
func validTimezone(name string) bool {
	if name == "" {
		return true
	}
	if name == "Local" {
		return false
	}
	_, err := time.LoadLocation(name)

	return err == nil
}

// handleTimezonePut is Settings' own instant save for the timezone, like
// handleThemePut: carrying one field through PUT /api/settings would blank
// every other saved setting.
func handleTimezonePut(store *settings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		var req timezonePutRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}
		if overBound(w, bound{"timezone", req.Timezone, maxTimezoneLen}) {
			return
		}
		if !validTimezone(req.Timezone) {
			writeJSON(w, http.StatusBadRequest, errorBody(`timezone must be "" or an IANA zone name such as "Europe/Amsterdam"`))

			return
		}

		existing, err := store.Get(r.Context(), u.ID)
		if err != nil && !errors.Is(err, settings.ErrNotFound) {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load existing settings"))

			return
		}
		existing.Timezone = req.Timezone

		if err := store.Set(r.Context(), u.ID, existing); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save timezone"))

			return
		}

		writeJSON(w, http.StatusOK, TimezoneResponse{Timezone: existing.Timezone})
	}
}
