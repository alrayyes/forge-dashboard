package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// webhookEnsureRequest matches components.schemas.WebhookEnsureRequest.
type webhookEnsureRequest struct {
	Forge    string `json:"forge"`
	FullName string `json:"fullName"`
}

// splitFullName splits "owner/repo" into its two halves. false for
// anything else — no slash, more than one, or an empty side.
func splitFullName(fullName string) (owner, name string, ok bool) {
	parts := strings.Split(fullName, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}

	return parts[0], parts[1], true
}

// clientErrorStatus maps a forge error's Kind to the HTTP status a caller
// should see — the same coarse categories ForgeHealth.ErrorKind already
// classifies forge failures into elsewhere, applied here to a single
// write instead of a whole snapshot. Shared by every endpoint that writes
// to a forge (webhook ensure, pull-request actions), not just this one.
func clientErrorStatus(err error) int {
	var clientErr *dashboard.ClientError
	if !errors.As(err, &clientErr) {
		return http.StatusBadGateway
	}
	switch clientErr.Kind {
	case dashboard.ForgeErrorUnauthorized:
		return http.StatusForbidden
	case dashboard.ForgeErrorNotFound:
		return http.StatusNotFound
	case dashboard.ForgeErrorConflict:
		return http.StatusConflict
	case dashboard.ForgeErrorRateLimited:
		return http.StatusTooManyRequests
	default:
		return http.StatusBadGateway
	}
}

// handleWebhookEnsure creates a webhook on the named repo, pointed at
// the signed-in user's own webhook URL and secret, or brings an
// existing forge-dashboard one back to active with the right config —
// dashboard.WebhookManager's own EnsureWebhook decides which, per
// forge. Unlike the passive coverage GET /api/dashboard reports, this
// is the one place forge-dashboard actually writes to a forge.
func handleWebhookEnsure(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		var req webhookEnsureRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}

		owner, name, ok := splitFullName(req.FullName)
		if !ok {
			writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

			return
		}

		creds, err := deps.SettingsStore.Get(r.Context(), u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load settings"))

			return
		}

		token, secret, err := deps.SettingsStore.EnsureWebhookCredentials(r.Context(), u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load webhook credentials"))

			return
		}

		var manager dashboard.WebhookManager
		for _, src := range deps.BuildSources(u.ID, creds) {
			if string(src.Forge()) != req.Forge {
				continue
			}
			m, supported := src.(dashboard.WebhookManager)
			if !supported {
				writeJSON(w, http.StatusBadRequest, errorBody(req.Forge+" doesn't support creating webhooks"))

				return
			}
			manager = m

			break
		}
		if manager == nil {
			writeJSON(w, http.StatusBadRequest, errorBody("no "+req.Forge+" credentials saved"))

			return
		}

		targetURL := deps.PublicOrigin + "/api/webhooks/" + req.Forge + "/" + token
		if err := manager.EnsureWebhook(r.Context(), owner, name, targetURL, secret); err != nil {
			slog.Warn("webhook ensure failed", "forge", req.Forge, "repo", req.FullName, "error", err)
			writeJSON(w, clientErrorStatus(err), errorBody(err.Error()))

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
