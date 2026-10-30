package api

import (
	"net/http"
	"strings"
)

// The API moved under /api/v1 (#3102). This file is the whole compatibility
// layer: delete it, and the legacyRoutes call in NewMux, once a release has
// shipped with it, and a stale tab's old address becomes a plain 404.

const (
	apiPrefix        = "/api/"
	apiVersionPrefix = "/api/v1/"

	// apiMajorVersion is what GET /api/version reports as apiVersion.
	apiMajorVersion = "v1"

	// legacyDeprecatedAt is when the unversioned addresses were deprecated,
	// as the Unix time RFC 9745's Deprecation header carries (2026-10-30).
	legacyDeprecatedAt = "@1793314800"
)

// unversionedAPIPath reports the paths that stay where they are: the forges
// hold the webhook URL they were registered with, and /api/version says which
// versions are served.
func unversionedAPIPath(path string) bool {
	return path == "/api/version" ||
		path == "/api/v1" ||
		strings.HasPrefix(path, apiVersionPrefix) ||
		strings.HasPrefix(path, "/api/webhooks/github/") ||
		strings.HasPrefix(path, "/api/webhooks/forgejo/")
}

// legacyRoutes answers 308 from an unversioned /api/... address to its
// /api/v1/... one, when the mux has a route there. A 308 keeps the method and
// body, so a page loaded before a deploy keeps working through it. Anything
// else under /api/ goes straight to the mux and its 404.
func legacyRoutes(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, apiPrefix) || unversionedAPIPath(r.URL.Path) {
			mux.ServeHTTP(w, r)

			return
		}

		target := apiVersionPrefix + strings.TrimPrefix(r.URL.Path, apiPrefix)

		probe := r.Clone(r.Context())
		probe.URL.Path = target
		// The JSON 404 catch-all (NewMux) is registered per method on "/api/", so
		// a match on it means no real route is there.
		if _, pattern := mux.Handler(probe); pattern == "" || strings.HasSuffix(pattern, " "+apiPrefix) {
			mux.ServeHTTP(w, r)

			return
		}

		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}

		w.Header().Set("Deprecation", legacyDeprecatedAt)
		w.Header().Set("Link", "<"+target+`>; rel="successor-version"`)
		// target always starts with the fixed /api/v1/ prefix, so it can only
		// point back into this server, never at another host.
		http.Redirect(w, r, target, http.StatusPermanentRedirect) //nolint:gosec // G710: fixed prefix, same-origin
	})
}
