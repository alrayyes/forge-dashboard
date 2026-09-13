package api

import "net/http"

// Health matches components.schemas.Health in api/openapi.yaml.
type Health struct {
	Status string `json:"status"`
}

// handleHealth answers 200 once the process has started — see the
// operation description in api/openapi.yaml for what it deliberately
// doesn't check.
func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, Health{Status: "ok"})
}

// Version matches components.schemas.Version in api/openapi.yaml.
type Version struct {
	Version string `json:"version"`
}

// handleVersion answers the release tag this binary was built from —
// public and unauthenticated, same as /healthz, so the pre-login page can
// link to it too.
func handleVersion(version string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, Version{Version: version})
	}
}
