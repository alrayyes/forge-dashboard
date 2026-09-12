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
// valid, unexpired session — everyone else gets a 401 JSON body, never
// the handler underneath.
func RequireAuth(store *Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := SessionToken(r)
			if !ok {
				unauthorized(w)
				return
			}

			u, err := store.UserForSession(r.Context(), token)
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
