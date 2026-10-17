package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
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
	// HideDependencyDashboard and IgnoredTitles (#1630) — see
	// settings.Credentials' own doc comments. IgnoredTitles is always a list
	// on the wire, never null.
	HideDependencyDashboard bool     `json:"hideDependencyDashboard"`
	IgnoredTitles           []string `json:"ignoredTitles"`
	// IgnoredTitleCounts (#1677) is, per entry of IgnoredTitles and in the
	// same order, how many of the viewer's open issues that pattern matches on
	// its own; nil (null on the wire) while that is unknown. Always a list.
	IgnoredTitleCounts []*int `json:"ignoredTitleCounts"`
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

func settingsResponseOf(c settings.Credentials, githubAppConfigured bool, titleCounts []*int) SettingsResponse {
	return SettingsResponse{
		GitHubUsername:          c.GitHubUsername,
		GitHubTokenSet:          c.GitHubToken != "",
		GitHubAppInstallationID: c.GitHubAppInstallationID,
		GitHubAppConfigured:     githubAppConfigured,
		ForgejoURL:              publicForgejoURL(c.ForgejoURL),
		ForgejoUsername:         c.ForgejoUsername,
		ForgejoTokenSet:         c.ForgejoToken != "",
		WebhookToken:            c.WebhookToken,
		WebhookSecret:           c.WebhookSecret,
		RenovateRebaseLabel:     c.RenovateRebaseLabel,
		RenovateAuthors:         append([]string{}, c.RenovateAuthors...),
		HideDependencyDashboard: c.HideDependencyDashboard,
		IgnoredTitles:           append([]string{}, c.IgnoredTitles...),
		IgnoredTitleCounts:      titleCounts,
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

		counts := ignoredTitleCounts(r.Context(), deps, u.ID, creds.IgnoredTitles, deps.Manager.Get(u.ID))
		writeJSON(w, http.StatusOK, settingsResponseOf(creds, deps.GitHubAppConfigured, counts))
	}
}

// handleSettingsSummaryGet answers GET /api/settings/summary: the same body as
// the get_settings MCP tool. Unlike handleSettingsGet it never provisions
// webhook credentials and never returns them.
func handleSettingsSummaryGet(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		summary, err := resolveSettingsSummary(r.Context(), deps, u)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody(err.Error()))

			return
		}

		writeJSON(w, http.StatusOK, summary)
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
	// HideDependencyDashboard and IgnoredTitles (#1630) replace the saved
	// values; omitted means false and empty, like RenovateAuthors.
	HideDependencyDashboard bool     `json:"hideDependencyDashboard"`
	IgnoredTitles           []string `json:"ignoredTitles"`
}

// cleanTitlePatterns trims the patterns, drops blanks and repeats (ignoring
// case), and answers whether the list is acceptable: at most
// maxIgnoredTitles entries, each at most maxIgnoredTitleLen characters and
// valid Go RE2 syntax. A rejection names the entry by its 1-based place in the
// list as sent, and says why in plain words (#1630).
func cleanTitlePatterns(w http.ResponseWriter, patterns []string) ([]string, bool) {
	reject := func(msg string) ([]string, bool) {
		writeJSON(w, http.StatusBadRequest, fieldErrorBody("ignoredTitles", msg))

		return nil, false
	}
	if len(patterns) > maxIgnoredTitles {
		return reject(fmt.Sprintf("ignoredTitles lists more than %d entries", maxIgnoredTitles))
	}

	var out []string
	seen := map[string]struct{}{}
	for i, p := range patterns {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if utf8.RuneCountInString(p) > maxIgnoredTitleLen {
			return reject(fmt.Sprintf("ignoredTitles entry %d is longer than %d characters", i+1, maxIgnoredTitleLen))
		}
		if _, err := dashboard.CompileTitlePatterns([]string{p}); err != nil {
			return reject(fmt.Sprintf("ignoredTitles entry %d (%q): %s", i+1, p, err))
		}
		if _, dup := seen[strings.ToLower(p)]; dup {
			continue
		}
		seen[strings.ToLower(p)] = struct{}{}
		out = append(out, p)
	}

	return out, true
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

// validForgejoURL answers 400 itself when raw isn't a plain http(s) base URL:
// one with a username, password, query string or fragment could carry a
// credential, and the settings endpoints echo this field back. Blank is fine
// (it clears the setting). The message never quotes the URL, since a rejected
// one is exactly the kind that holds a secret.
func validForgejoURL(w http.ResponseWriter, raw string) bool {
	if raw == "" {
		return true
	}
	reject := func(msg string) bool {
		writeJSON(w, http.StatusBadRequest, fieldErrorBody("forgejoUrl", msg))

		return false
	}
	u, err := url.Parse(raw)
	switch {
	case err != nil:
		return reject("forgejoUrl is not a valid URL")
	case (u.Scheme != "http" && u.Scheme != "https") || u.Host == "":
		return reject("forgejoUrl must be an http:// or https:// address with a host")
	case u.User != nil:
		return reject("forgejoUrl must not contain a username or password")
	case u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#"):
		return reject("forgejoUrl must not contain a query string or fragment")
	}

	return true
}

// publicForgejoURL is a stored Forgejo URL as it may be shown: without any
// userinfo, query or fragment. Saves refuse those now, but a row saved before
// that can still hold one. A value that no longer parses is shown as empty,
// since there's no telling where its credentials end.
func publicForgejoURL(stored string) string {
	u, err := url.Parse(stored)
	if err != nil {
		return ""
	}
	u.User, u.RawQuery, u.ForceQuery, u.Fragment, u.RawFragment = nil, "", false, "", ""

	return u.String()
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
	if !validForgejoURL(w, req.ForgejoURL) {
		return settingsPutRequest{}, false
	}
	var ok bool
	if req.RenovateAuthors, ok = cleanLogins(w, req.RenovateAuthors); !ok {
		return settingsPutRequest{}, false
	}

	if req.IgnoredTitles, ok = cleanTitlePatterns(w, req.IgnoredTitles); !ok {
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
		HideDependencyDashboard: req.HideDependencyDashboard,
		IgnoredTitles:           req.IgnoredTitles,
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

		// Taken before Ensure below, which swaps in an Aggregator with no
		// snapshot yet: the counts answer the list just saved, against the
		// issues the viewer was looking at when they saved it.
		snap := deps.Manager.Get(u.ID)

		if err := deps.SettingsStore.Set(r.Context(), u.ID, merged); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save settings"))

			return
		}

		// deps.AppContext: see the identical comment in auth.go's
		// startSession — this background refresh loop has to outlive the
		// request that started it.
		deps.Manager.Ensure(deps.AppContext, u.ID, deps.BuildSources(u.ID, merged))

		counts := ignoredTitleCounts(r.Context(), deps, u.ID, merged.IgnoredTitles, snap)
		writeJSON(w, http.StatusOK, settingsResponseOf(merged, deps.GitHubAppConfigured, counts))
	}
}

// ignoredTitleCounts answers, for each of patterns in order, how many of the
// open issues in snap that pattern matches on its own (#1677). It works from
// the same issues settingsHiddenIssueCount does (those of repos whose issues
// aren't ignored) and the same matcher, but per pattern, so an issue two
// patterns match counts for both. Every entry is nil while the count is
// unknown, never a made-up 0: see snapshotKnown. The slice is never nil.
func ignoredTitleCounts(ctx context.Context, deps Deps, userID []byte, patterns []string, snap dashboard.Snapshot) []*int {
	if len(patterns) == 0 || !snapshotKnown(snap) {
		return make([]*int, len(patterns))
	}

	board := loadBoardSettings(ctx, deps.SettingsStore, userID)

	return titleCounts(patterns, snap.Issues, func(issue dashboard.Issue) bool {
		return board.ignored[settings.WebhookDeliveryKey(string(issue.Forge), issue.Repo)].Issues
	})
}

// snapshotKnown reports whether snap says anything about the viewer's issues.
// A zero GeneratedAt is no snapshot at all. A stamped one can still be empty
// because every forge failed its first fetch, which tells us nothing: it
// counts only when some forge answered (Reachable) or has older data on show
// (StaleSince).
func snapshotKnown(snap dashboard.Snapshot) bool {
	if snap.GeneratedAt.IsZero() {
		return false
	}
	for _, f := range snap.Forges {
		if f.Reachable || f.StaleSince != nil {
			return true
		}
	}

	return false
}

// titleCounts counts, per pattern, the issues it matches that skip doesn't
// leave out. A pattern that doesn't compile gets nil, not 0.
func titleCounts(patterns []string, issues []dashboard.Issue, skip func(dashboard.Issue) bool) []*int {
	counts := make([]*int, len(patterns))
	for i, p := range patterns {
		matcher, err := dashboard.CompileTitlePatterns([]string{p})
		if err != nil {
			continue
		}
		n := 0
		for _, issue := range issues {
			if !skip(issue) && matcher.Matches(issue.Title) {
				n++
			}
		}
		counts[i] = &n
	}

	return counts
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

// SettingsSummary matches components.schemas.SettingsSummary, and is the
// output of the get_settings MCP tool: SettingsResponse without the webhook
// token and secret, which are never returned, plus whether they exist. Kept in
// step with SettingsResponse by a test that compares the two.
type SettingsSummary struct {
	GitHubUsername          string   `json:"githubUsername"`
	GitHubTokenSet          bool     `json:"githubTokenSet"`
	GitHubAppInstallationID int64    `json:"githubAppInstallationId"`
	GitHubAppConfigured     bool     `json:"githubAppConfigured"`
	ForgejoURL              string   `json:"forgejoUrl"`
	ForgejoUsername         string   `json:"forgejoUsername"`
	ForgejoTokenSet         bool     `json:"forgejoTokenSet"`
	WebhookConfigured       bool     `json:"webhookConfigured"`
	RenovateRebaseLabel     string   `json:"renovateRebaseLabel"`
	RenovateAuthors         []string `json:"renovateAuthors"`
	HideDependencyDashboard bool     `json:"hideDependencyDashboard"`
	IgnoredTitles           []string `json:"ignoredTitles"`
	IgnoredTitleCounts      []*int   `json:"ignoredTitleCounts"`
	Theme                   string   `json:"theme"`
	Timezone                string   `json:"timezone"`
}

var errCouldNotLoadSettings = errors.New("could not load settings")

// resolveSettingsSummary reads u's saved settings without writing anything: no
// webhook credentials are created, and the ones that exist are reduced to a
// flag. A user with no saved row gets the zero settings. It is the one builder
// behind both GET /api/settings/summary and the get_settings MCP tool.
func resolveSettingsSummary(ctx context.Context, deps Deps, u *auth.User) (SettingsSummary, error) {
	creds, err := deps.SettingsStore.Get(ctx, u.ID)
	if err != nil && !errors.Is(err, settings.ErrNotFound) {
		return SettingsSummary{}, errCouldNotLoadSettings
	}
	full := settingsResponseOf(creds, deps.GitHubAppConfigured, ignoredTitleCounts(ctx, deps, u.ID, creds.IgnoredTitles, deps.Manager.Get(u.ID)))

	return SettingsSummary{
		GitHubUsername:          full.GitHubUsername,
		GitHubTokenSet:          full.GitHubTokenSet,
		GitHubAppInstallationID: full.GitHubAppInstallationID,
		GitHubAppConfigured:     full.GitHubAppConfigured,
		ForgejoURL:              full.ForgejoURL,
		ForgejoUsername:         full.ForgejoUsername,
		ForgejoTokenSet:         full.ForgejoTokenSet,
		WebhookConfigured:       creds.WebhookToken != "" && creds.WebhookSecret != "",
		RenovateRebaseLabel:     full.RenovateRebaseLabel,
		RenovateAuthors:         full.RenovateAuthors,
		HideDependencyDashboard: full.HideDependencyDashboard,
		IgnoredTitles:           full.IgnoredTitles,
		IgnoredTitleCounts:      full.IgnoredTitleCounts,
		Theme:                   full.Theme,
		Timezone:                full.Timezone,
	}, nil
}
