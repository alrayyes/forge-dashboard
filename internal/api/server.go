package api

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

//go:embed all:static
var staticFiles embed.FS

// NewMux wires the handlers registered against api/openapi.yaml: liveness,
// passkey registration/login/session, the aggregated dashboard snapshot,
// and the static frontend that consumes it. getSnapshot is called fresh
// on every request, so a request always sees whatever the aggregator most
// recently assembled — typically (*dashboard.Aggregator).Get.
//
// The dashboard itself, and the page that renders it, require a valid
// session; registration, login and the handful of static assets a login
// page needs (its own HTML/JS, the shared stylesheet, the favicon) don't.
func NewMux(getSnapshot func() dashboard.Snapshot, authService *auth.Service, authStore *auth.Store) *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", handleHealth)

	mux.HandleFunc("POST /api/auth/register/begin", handleRegisterBegin(authService))
	mux.HandleFunc("POST /api/auth/register/finish", handleRegisterFinish(authService))
	mux.HandleFunc("POST /api/auth/login/begin", handleLoginBegin(authService))
	mux.HandleFunc("POST /api/auth/login/finish", handleLoginFinish(authService))
	mux.HandleFunc("POST /api/auth/logout", handleLogout(authStore))
	mux.Handle("GET /api/auth/session", auth.RequireAuth(authStore)(handleGetSession()))

	mux.Handle("GET /api/dashboard", auth.RequireAuth(authStore)(handleDashboard(getSnapshot)))

	static, err := fs.Sub(staticFiles, "static")
	if err != nil {
		// Only possible if the embed directive above stops matching a
		// "static" directory that exists at build time — a build-time
		// guarantee, not a runtime condition to recover from.
		panic(err)
	}
	fileServer := http.FileServerFS(static)

	// The dashboard page and the script that populates it need a session,
	// same as the API they call — an unauthenticated visitor is bounced to
	// the login page rather than shown an empty shell asking it to fetch
	// data it isn't allowed to have. Everything else under static/ (the
	// login page itself, the shared stylesheet, the favicon) stays public;
	// "/{$}" and "/app.js" are more specific than the catch-all "/" below
	// and win for those two paths.
	mux.Handle("GET /{$}", requireAuthPage(authStore, fileServer))
	mux.Handle("GET /app.js", requireAuthPage(authStore, fileServer))
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
