package auth

import (
	"net/http"
	"time"
)

// CookieName is the session cookie forge-dashboard sets and reads. Its
// value is an opaque token — Store.UserForSession is what resolves it to
// a user, never anything decoded client-side.
const CookieName = "forge_dashboard_session"

// SetSessionCookie sets token as the session cookie on w. secure mirrors
// whether the request itself arrived over HTTPS — see isHTTPS, called by
// the handler that has the *http.Request this cookie is a response to.
func SetSessionCookie(w http.ResponseWriter, token string, secure bool) {
	// HttpOnly, Secure and SameSite are all set below; gosec's G124 can't
	// tell that from a struct literal whose Secure field is a parameter
	// rather than a literal `true`, so it flags this as if none were set.
	// #nosec G124 -- secure comes from IsHTTPS, not omitted.
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Now().Add(SessionTTL),
	})
}

// ClearSessionCookie expires the session cookie immediately — logout.
func ClearSessionCookie(w http.ResponseWriter, secure bool) {
	// #nosec G124 -- see SetSessionCookie.
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

// SessionToken reads the session cookie from r, if any.
func SessionToken(r *http.Request) (string, bool) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return "", false
	}
	return c.Value, true
}

// IsHTTPS reports whether r itself arrived over TLS, directly or via a
// reverse proxy that sets the standard forwarded-proto header (Traefik,
// in front of this service's own deployment, terminates TLS and always
// sets it) — the deciding factor for whether the session cookie can carry
// Secure without locking out a plain-HTTP local dev run.
func IsHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return r.Header.Get("X-Forwarded-Proto") == "https"
}
