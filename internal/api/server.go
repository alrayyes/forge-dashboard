package api

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
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

	// Manager holds each signed-in user's own Aggregator, built from
	// their saved Credentials via BuildSources.
	Manager      *dashboard.Manager
	BuildSources func(settings.Credentials) []dashboard.Source

	// AppContext is the process's own long-lived context (canceled on
	// shutdown), not any one request's — a handler that starts a
	// Manager-owned background refresh goroutine has to root it here, not
	// in the *http.Request context that dies the moment that handler
	// returns.
	AppContext context.Context
}

// NewMux wires the handlers registered against api/openapi.yaml: liveness,
// passkey registration/login/session, per-user settings, the aggregated
// dashboard snapshot, and the static frontend that consumes it.
//
// The dashboard itself, and the page that renders it, require a valid
// session; registration, login and the handful of static assets a login
// page needs (its own HTML/JS, the shared stylesheet, the favicon) don't.
func NewMux(deps Deps) *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", handleHealth)
	mux.HandleFunc("GET /api/version", handleVersion(deps.Version))

	mux.HandleFunc("POST /api/auth/register/begin", handleRegisterBegin(deps.AuthService))
	mux.HandleFunc("POST /api/auth/register/finish", handleRegisterFinish(deps))
	mux.HandleFunc("POST /api/auth/login/begin", handleLoginBegin(deps.AuthService))
	mux.HandleFunc("POST /api/auth/login/finish", handleLoginFinish(deps))
	mux.HandleFunc("POST /api/auth/logout", handleLogout(deps.AuthStore))
	mux.Handle("GET /api/auth/session", auth.RequireAuth(deps.AuthStore)(handleGetSession()))

	mux.Handle("GET /api/dashboard", auth.RequireAuth(deps.AuthStore)(handleDashboard(deps)))
	mux.Handle("GET /api/dashboard/stream", auth.RequireAuth(deps.AuthStore)(handleDashboardStream(deps)))
	mux.Handle("POST /api/dashboard/refresh", auth.RequireAuth(deps.AuthStore)(handleDashboardRefresh(deps)))
	mux.Handle("GET /api/settings", auth.RequireAuth(deps.AuthStore)(handleSettingsGet(deps.SettingsStore)))
	mux.Handle("PUT /api/settings", auth.RequireAuth(deps.AuthStore)(handleSettingsPut(deps)))

	mux.Handle("GET /api/sharing", auth.RequireAuth(deps.AuthStore)(handleSharingGet(deps)))
	mux.Handle("PUT /api/sharing/{username}", auth.RequireAuth(deps.AuthStore)(handleSharingPut(deps)))
	mux.Handle("DELETE /api/sharing/{username}", auth.RequireAuth(deps.AuthStore)(handleSharingDelete(deps)))

	mux.Handle("GET /api/admin/users", auth.RequireAuth(deps.AuthStore)(auth.RequireAdmin(handleAdminListUsers(deps.AuthStore))))
	mux.Handle("POST /api/admin/users/{username}/revoke", auth.RequireAuth(deps.AuthStore)(auth.RequireAdmin(handleAdminRevokeUser(deps))))
	mux.Handle("DELETE /api/admin/users/{username}", auth.RequireAuth(deps.AuthStore)(auth.RequireAdmin(handleAdminDeleteUser(deps))))

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

	return mux
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
