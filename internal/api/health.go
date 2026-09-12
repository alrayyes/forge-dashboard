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
