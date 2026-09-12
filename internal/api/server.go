package api

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

//go:embed all:static
var staticFiles embed.FS

// NewMux wires the handlers registered against api/openapi.yaml: liveness,
// the aggregated dashboard snapshot, and the static frontend that consumes
// it. getSnapshot is called fresh on every request, so a request always
// sees whatever the aggregator most recently assembled — typically
// (*dashboard.Aggregator).Get.
func NewMux(getSnapshot func() dashboard.Snapshot) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealth)
	mux.HandleFunc("GET /api/dashboard", handleDashboard(getSnapshot))

	static, err := fs.Sub(staticFiles, "static")
	if err != nil {
		// Only possible if the embed directive above stops matching a
		// "static" directory that exists at build time — a build-time
		// guarantee, not a runtime condition to recover from.
		panic(err)
	}
	mux.Handle("GET /", http.FileServerFS(static))

	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
