package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

type contextKey int

const userContextKey contextKey = 0

// UserFromContext returns the authenticated user a RequireAuth-wrapped
// handler is running for. Only ever called from inside such a handler, so
// the zero value (found false) means RequireAuth itself has a bug, not a
// condition a caller needs to handle gracefully.
func UserFromContext(ctx context.Context) (*User, bool) {
	u, ok := ctx.Value(userContextKey).(*User)
	return u, ok
}

// RequireAuth wraps next so it only ever runs for a request carrying a
// valid, unexpired session cookie or a valid personal API token
// (Authorization: Bearer <token>) — everyone else gets a 401 JSON body,
// never the handler underneath. Cookie checked first, Bearer as the
// fallback: the common case (a browser) never pays for a second lookup,
// and a script sending both would be unusual enough that "cookie wins"
// is a fine tiebreak rather than something worth its own rule.
func RequireAuth(store *Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var (
				u   *User
				err error
			)
			if token, ok := SessionToken(r); ok {
				u, err = store.UserForSession(r.Context(), token)
			} else if token, ok := BearerToken(r); ok {
				u, err = store.UserForAPIToken(r.Context(), token)
			} else {
				unauthorized(w)
				return
			}

			if err != nil {
				if !errors.Is(err, ErrNotFound) {
					http.Error(w, "internal error", http.StatusInternalServerError)
					return
				}
				unauthorized(w)
				return
			}

			ctx := context.WithValue(r.Context(), userContextKey, u)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "not authenticated"})
}

// RequireAdmin wraps next so it only ever runs for the designated admin —
// everyone else gets a 403. Compose it inside RequireAuth
// (RequireAuth(store)(RequireAdmin(next))), since it reads the user
// RequireAuth already put in context rather than looking one up itself.
func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := UserFromContext(r.Context())
		if !ok || !u.IsAdmin {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "admin access required"})
			return
		}
		next.ServeHTTP(w, r)
	})
}
