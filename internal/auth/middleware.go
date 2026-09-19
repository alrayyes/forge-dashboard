package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

type contextKey int

const (
	userContextKey contextKey = iota
	accessLogUsernameKey
)

// UserFromContext returns the authenticated user a RequireAuth-wrapped
// handler is running for. Only ever called from inside such a handler, so
// the zero value (found false) means RequireAuth itself has a bug, not a
// condition a caller needs to handle gracefully.
func UserFromContext(ctx context.Context) (*User, bool) {
	u, ok := ctx.Value(userContextKey).(*User)

	return u, ok
}

// WithAccessLogUsername returns a context carrying a pointer RequireAuth
// fills in with the resolved username, once it resolves one, plus that
// same pointer for the caller to read back later (#371).
//
// An access-log middleware has to wrap outside RequireAuth — a rejected or
// unauthenticated request still needs logging — so by the time it can log
// anything, whatever RequireAuth put in *its own* request's context is
// already gone: r.WithContext returns a new *http.Request rather than
// mutating the caller's, so a value added deeper in the chain never
// becomes visible on the outer handler's own (now-stale) request. What
// does survive the round trip is a pointer carried through that context:
// writing to what it points at is visible to anyone still holding the
// same pointer, however many WithContext copies sit in between — which is
// exactly what the caller here keeps hold of.
func WithAccessLogUsername(ctx context.Context) (context.Context, *string) {
	slot := new(string)

	return context.WithValue(ctx, accessLogUsernameKey, slot), slot
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

			if slot, ok := r.Context().Value(accessLogUsernameKey).(*string); ok {
				*slot = u.Username
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
