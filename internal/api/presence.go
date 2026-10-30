package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

const (
	minViewerIDLen  = 8
	maxViewerIDLen  = 64
	maxPresenceBody = 1 << 10
)

type presenceReport struct {
	ViewerID string `json:"viewerId"`
	Visible  *bool  `json:"visible"`
}

type presenceAnswer struct {
	HeartbeatSeconds int `json:"heartbeatSeconds"`
	IdleAfterSeconds int `json:"idleAfterSeconds"`
}

// handleDashboardPresence records whether one browser tab is being looked at,
// which is the only way the server learns it: an open live stream says
// nothing. See POST /api/v1/presence in the OpenAPI spec.
func handleDashboardPresence(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req presenceReport
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPresenceBody))
		if err := dec.Decode(&req); err != nil || req.Visible == nil ||
			len(strings.TrimSpace(req.ViewerID)) < minViewerIDLen || len(req.ViewerID) > maxViewerIDLen {
			writeJSON(w, http.StatusBadRequest, errorBody("viewerId (8 to 64 characters) and visible are required"))

			return
		}

		activity := deps.Service.Activity()
		activity.Present(req.ViewerID, *req.Visible)

		writeJSON(w, http.StatusOK, presenceAnswer{
			HeartbeatSeconds: int(dashboard.PresenceHeartbeat / time.Second),
			IdleAfterSeconds: int(activity.IdleAfter() / time.Second),
		})
	}
}
