package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

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
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}

		creds, err := deps.SettingsStore.Get(r.Context(), t.user.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load settings"))

			return
		}

		token, secret, err := deps.SettingsStore.EnsureWebhookCredentials(r.Context(), t.user.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load webhook credentials"))

			return
		}

		src, ok := findForgeSource(w, deps, t.user.ID, creds, t.req.Forge)
		if !ok {
			return
		}
		manager, ok := capabilityOf[dashboard.WebhookManager](w, src, t.req.Forge, "doesn't support creating webhooks")
		if !ok {
			return
		}

		targetURL := deps.PublicOrigin + "/api/webhooks/" + t.req.Forge + "/" + token
		if err := manager.EnsureWebhook(r.Context(), t.owner, t.name, targetURL, secret); err != nil {
			slog.Warn("webhook ensure failed", "forge", t.req.Forge, "repo", t.req.FullName, "error", err)
			writeRefusal(w, clientErrorStatus(err), dashboard.ClassifyForgeRefusal(err), err, "forge", t.req.Forge, "repo", t.req.FullName)

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
