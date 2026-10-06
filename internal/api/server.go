package api

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/alrayyes/forge-dashboard/internal/sharing"
)

//go:embed all:static
var staticFiles embed.FS

// Deps is everything NewMux needs — passed as one struct rather than a
// long parameter list, since it's grown one dependency per feature slice
// (auth, then per-user settings) and reads better named than positional.
type Deps struct {
	// Version is the release tag this binary was built from ("dev" for a
	// build outside the release pipeline) — see cmd/forge-dashboard's own
	// version var for how it's set.
	Version string

	AuthService *auth.Service
	AuthStore   *auth.Store

	SettingsStore *settings.Store
	SharingStore  *sharing.Store

	// Database and Dashboard back GET /readyz. Either may be nil, in which
	// case that check is skipped.
	Database  DatabasePinger
	Dashboard FirstRefreshGate

	// ReadyProbeTimeout bounds the database ping and ReadyCacheTTL is how
	// long its result is reused; zero means the defaults (2s and 3s).
	ReadyProbeTimeout time.Duration
	ReadyCacheTTL     time.Duration
	// Drain, once started, makes /readyz answer 503 so a router stops
	// sending traffic before shutdown. Nil never drains.
	Drain *Drain

	// Manager holds each signed-in user's own Aggregator, built from
	// their saved Credentials via BuildSources.
	Manager *dashboard.Manager
	// BuildSources takes the signed-in user's own ID (#482: threaded
	// through so the forge clients it builds can record outbound
	// requests under the right account) alongside their saved
	// Credentials.
	BuildSources func(userID []byte, c settings.Credentials) []dashboard.Source

	// RequestLog is the admin-only outbound-request log's own read path
	// — every account's forge clients record into the same underlying
	// store (see cmd/forge-dashboard's buildSourcesForUser), so this one
	// instance, with no account bound to it, is enough to list or export
	// across all of them.
	RequestLog *requestlog.SQLiteRecorder

	// PublicOrigin is this instance's own externally-reachable origin
	// (RP_ORIGIN — the same value WebAuthn's relying-party config
	// already requires be set correctly, reused rather than adding a
	// second "what's my own address" env var). handleWebhookEnsure uses
	// it to build the exact URL a webhook it creates should target;
	// nothing else here needs it, since matching an existing hook
	// (dashboard.WebhookTargetsPath) only ever compares by path.
	PublicOrigin string

	// GitHubAppConfigured is whether this deployment has a GitHub App set
	// up at all (#620) — server-wide GITHUB_APP_ID/
	// GITHUB_APP_PRIVATE_KEY_BASE64, read once at startup, never a
	// per-user setting. handleSettingsGet/handleSettingsPut use it to
	// explain and enforce why a saved githubAppInstallationId can't work
	// on a server with no App configured.
	GitHubAppConfigured bool

	// AppContext is the process's own long-lived context (canceled on
	// shutdown), not any one request's — a handler that starts a
	// Manager-owned background refresh goroutine has to root it here, not
	// in the *http.Request context that dies the moment that handler
	// returns.
	AppContext context.Context
}

// NewMux wires the handlers registered against api/openapi.yaml: liveness, readiness,
// passkey registration/login/session, per-user settings, the aggregated
// dashboard snapshot, and the static frontend that consumes it.
//
// The dashboard itself, and the page that renders it, require a valid
// session; registration, login and the handful of static assets a login
// page needs (its own HTML/JS, the shared stylesheet, the favicon) don't.
//
//nolint:funlen // a route table: one statement per route, which splitting would only scatter
func NewMux(deps Deps) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", handleHealth)
	mux.HandleFunc("GET /readyz", handleReady(deps))
	mux.HandleFunc("GET /api/version", handleVersion(deps.Version))

	mux.HandleFunc("GET /api/auth/registration-status", handleRegistrationStatus(deps.AuthService))
	mux.HandleFunc("POST /api/auth/register/begin", handleRegisterBegin(deps.AuthService))
	mux.HandleFunc("POST /api/auth/register/finish", handleRegisterFinish(deps))
	mux.HandleFunc("POST /api/auth/login/begin", handleLoginBegin(deps.AuthService))
	mux.HandleFunc("POST /api/auth/login/finish", handleLoginFinish(deps))
	mux.HandleFunc("POST /api/auth/logout", handleLogout(deps.AuthStore))
	mux.Handle("GET /api/auth/session", auth.RequireAuth(deps.AuthStore)(handleGetSession()))

	mux.Handle("GET /api/dashboard", auth.RequireAuth(deps.AuthStore)(handleDashboard(deps)))
	mux.Handle("GET /api/dashboard/stream", auth.RequireAuth(deps.AuthStore)(handleDashboardStream(deps)))
	mux.Handle("POST /api/dashboard/refresh", auth.RequireAuth(deps.AuthStore)(handleDashboardRefresh(deps)))
	// The Streamable HTTP transport itself routes GET (a standalone SSE
	// stream), POST (JSON-RPC requests) and DELETE (session close) on
	// this one path -- registering all three against the same handler
	// instance, since a bare, method-less "/api/mcp" pattern conflicts
	// with the "GET /" catch-all registered below (ServeMux requires an
	// unambiguous method/path precedence between any two patterns).
	mcpHandler := auth.RequireAuth(deps.AuthStore)(newMCPHandler(deps))
	mux.Handle("GET /api/mcp", mcpHandler)
	mux.Handle("POST /api/mcp", mcpHandler)
	mux.Handle("DELETE /api/mcp", mcpHandler)
	mux.Handle("GET /api/settings", auth.RequireAuth(deps.AuthStore)(handleSettingsGet(deps)))
	mux.Handle("PUT /api/settings", auth.RequireAuth(deps.AuthStore)(handleSettingsPut(deps)))
	mux.Handle("GET /api/settings/theme", auth.RequireAuth(deps.AuthStore)(handleThemeGet(deps.SettingsStore)))
	mux.Handle("PUT /api/settings/theme", auth.RequireAuth(deps.AuthStore)(handleThemePut(deps.SettingsStore)))
	mux.Handle("GET /api/settings/timezone", auth.RequireAuth(deps.AuthStore)(handleTimezoneGet(deps.SettingsStore)))
	mux.Handle("PUT /api/settings/timezone", auth.RequireAuth(deps.AuthStore)(handleTimezonePut(deps.SettingsStore)))
	mux.Handle("GET /api/settings/filter-state", auth.RequireSession(deps.AuthStore)(handleFilterStateGet(deps.SettingsStore)))
	mux.Handle("PUT /api/settings/filter-state", auth.RequireSession(deps.AuthStore)(handleFilterStatePut(deps.SettingsStore)))
	mux.Handle("GET /api/auth/credentials", auth.RequireAuth(deps.AuthStore)(handleCredentialsGet(deps.AuthStore)))
	mux.Handle("POST /api/auth/credentials/begin", auth.RequireAuth(deps.AuthStore)(handleCredentialsAddBegin(deps.AuthService)))
	mux.Handle("POST /api/auth/credentials/finish", auth.RequireAuth(deps.AuthStore)(handleCredentialsAddFinish(deps)))
	mux.Handle("DELETE /api/auth/credentials/{id}", auth.RequireAuth(deps.AuthStore)(handleCredentialsDelete(deps.AuthStore)))
	mux.Handle("GET /api/tokens", auth.RequireAuth(deps.AuthStore)(handleTokensGet(deps.AuthStore)))
	mux.Handle("POST /api/tokens", auth.RequireAuth(deps.AuthStore)(handleTokensPost(deps.AuthStore)))
	mux.Handle("DELETE /api/tokens/{id}", auth.RequireAuth(deps.AuthStore)(handleTokensDelete(deps.AuthStore)))
	mux.Handle("POST /api/webhooks/ensure", auth.RequireAuth(deps.AuthStore)(handleWebhookEnsure(deps)))
	mux.Handle("POST /api/repos/ignore", auth.RequireAuth(deps.AuthStore)(handleRepoIgnore(deps)))
	mux.Handle("POST /api/repos/unignore", auth.RequireAuth(deps.AuthStore)(handleRepoUnignore(deps)))
	mux.Handle("POST /api/repos/auto-update-branch/enable", auth.RequireAuth(deps.AuthStore)(handleAutoUpdateBranchEnable(deps)))
	mux.Handle("POST /api/repos/auto-update-branch/disable", auth.RequireAuth(deps.AuthStore)(handleAutoUpdateBranchDisable(deps)))
	mux.Handle("POST /api/pull-requests/merge", auth.RequireAuth(deps.AuthStore)(handlePullRequestMerge(deps)))
	mux.Handle("POST /api/pull-requests/auto-merge", auth.RequireAuth(deps.AuthStore)(handlePullRequestAutoMerge(deps)))
	mux.Handle("POST /api/pull-requests/auto-merge/cancel", auth.RequireAuth(deps.AuthStore)(handlePullRequestAutoMergeCancel(deps)))
	mux.Handle("POST /api/pull-requests/close", auth.RequireAuth(deps.AuthStore)(handlePullRequestClose(deps)))
	mux.Handle("POST /api/pull-requests/update-branch", auth.RequireAuth(deps.AuthStore)(handlePullRequestUpdateBranch(deps)))
	mux.Handle("POST /api/pull-requests/rerun-checks", auth.RequireAuth(deps.AuthStore)(handlePullRequestRerunChecks(deps)))
	mux.Handle("POST /api/pull-requests/dependabot-action", auth.RequireAuth(deps.AuthStore)(handlePullRequestDependabotAction(deps)))
	mux.Handle("POST /api/pull-requests/renovate-rebase", auth.RequireAuth(deps.AuthStore)(handlePullRequestRenovateRebase(deps)))
	mux.Handle("GET /api/pull-requests/checks", auth.RequireAuth(deps.AuthStore)(handlePullRequestChecks(deps)))

	mux.Handle("GET /api/sharing", auth.RequireAuth(deps.AuthStore)(handleSharingGet(deps)))
	mux.Handle("PUT /api/sharing/{username}", auth.RequireAuth(deps.AuthStore)(handleSharingPut(deps)))
	mux.Handle("DELETE /api/sharing/{username}", auth.RequireAuth(deps.AuthStore)(handleSharingDelete(deps)))

	mux.Handle("GET /api/admin/users", auth.RequireAuth(deps.AuthStore)(auth.RequireAdmin(handleAdminListUsers(deps.AuthStore))))
	mux.Handle("POST /api/admin/users/{username}/revoke", auth.RequireAuth(deps.AuthStore)(auth.RequireAdmin(handleAdminRevokeUser(deps))))
	mux.Handle("DELETE /api/admin/users/{username}", auth.RequireAuth(deps.AuthStore)(auth.RequireAdmin(handleAdminDeleteUser(deps))))
	mux.Handle("POST /api/admin/invites", auth.RequireAuth(deps.AuthStore)(auth.RequireAdmin(handleAdminCreateInvite(deps))))
	mux.Handle("GET /api/admin/invites", auth.RequireAuth(deps.AuthStore)(auth.RequireAdmin(handleAdminListInvites(deps.AuthStore))))
	mux.Handle("POST /api/admin/invites/{token}/revoke", auth.RequireAuth(deps.AuthStore)(auth.RequireAdmin(handleAdminRevokeInvite(deps.AuthStore))))
	mux.Handle("GET /api/admin/requests", auth.RequireAuth(deps.AuthStore)(auth.RequireAdmin(handleAdminListRequests(deps))))
	mux.Handle("GET /api/admin/requests/export", auth.RequireAuth(deps.AuthStore)(auth.RequireAdmin(handleAdminExportRequests(deps))))

	// Not session-authenticated like everything above — the path's token
	// identifies the user, and the request's own HMAC signature is what
	// proves it actually came from their forge. See internal/api/webhooks.go.
	mux.HandleFunc("POST /api/webhooks/github/{webhookToken}", handleGitHubWebhook(deps.AppContext, deps.SettingsStore, deps.Manager))
	mux.HandleFunc("POST /api/webhooks/forgejo/{webhookToken}", handleForgejoWebhook(deps.AppContext, deps.SettingsStore, deps.Manager))

	static, err := fs.Sub(staticFiles, "static")
	if err != nil {
		// Only possible if the embed directive above stops matching a
		// "static" directory that exists at build time — a build-time
		// guarantee, not a runtime condition to recover from.
		panic(err)
	}
	fileServer := http.FileServerFS(static)

	// The dashboard page, the settings page, and the scripts that
	// populate them all need a session, same as the API they call — an
	// unauthenticated visitor is bounced to the login page rather than
	// shown an empty shell asking it to fetch data it isn't allowed to
	// have. Everything else under static/ (the login page itself, the
	// shared stylesheet, the favicon) stays public; these specific paths
	// are more specific than the catch-all "/" below and win for them.
	mux.Handle("GET /{$}", requireAuthPage(deps.AuthStore, fileServer))
	mux.Handle("GET /app.js", requireAuthPage(deps.AuthStore, fileServer))
	mux.Handle("GET /settings.html", requireAuthPage(deps.AuthStore, fileServer))
	mux.Handle("GET /settings.js", requireAuthPage(deps.AuthStore, fileServer))
	mux.Handle("GET /issues.html", requireAuthPage(deps.AuthStore, fileServer))
	mux.Handle("GET /insights.html", requireAuthPage(deps.AuthStore, fileServer))
	mux.Handle("GET /insights.js", requireAuthPage(deps.AuthStore, fileServer))
	mux.Handle("GET /webhooks.html", requireAuthPage(deps.AuthStore, fileServer))
	mux.Handle("GET /webhooks.js", requireAuthPage(deps.AuthStore, fileServer))
	// admin.html/js only need a session at this layer — a non-admin who
	// navigates here directly gets bounced by the page's own JS once
	// /api/admin/users answers 403, same as any other API call it makes.
	mux.Handle("GET /admin.html", requireAuthPage(deps.AuthStore, fileServer))
	mux.Handle("GET /admin.js", requireAuthPage(deps.AuthStore, fileServer))
	mux.Handle("GET /", fileServer)

	return accessLogMiddleware(limitRequestBody(mux))
}

// maxRequestBodyBytes caps what any JSON endpoint reads (#1008). Every body
// here is a handful of short fields; 1 MiB is far past the biggest honest one
// and far below anything that strains the process.
const maxRequestBodyBytes = 1 << 20

// limitRequestBody refuses a body past the cap. A declared length over it is
// answered 413 before the handler reads a byte. A body with no declared
// length (chunked) is cut off at the cap instead, so the handler's own decode
// fails and it answers 400. The forges' webhook routes keep their own, larger
// cap in the handler (maxWebhookBodyBytes), since a forge's payload can be big.
func limitRequestBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/webhooks/github/") || strings.HasPrefix(r.URL.Path, "/api/webhooks/forgejo/") {
			next.ServeHTTP(w, r)

			return
		}
		if r.ContentLength > maxRequestBodyBytes {
			writeJSON(w, http.StatusRequestEntityTooLarge, errorBody("request body too large"))

			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
		next.ServeHTTP(w, r)
	})
}

// requireAuthPage is RequireAuth's page-navigation counterpart: a redirect
// to the login page instead of a JSON 401, since this guards something a
// browser navigates to directly rather than something the frontend's own
// JS calls and can handle a 401 from itself.
func requireAuthPage(store *auth.Store, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := auth.SessionToken(r)
		if ok {
			if _, err := store.UserForSession(r.Context(), token); err == nil {
				next.ServeHTTP(w, r)

				return
			}
		}
		http.Redirect(w, r, "/login.html", http.StatusFound)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
