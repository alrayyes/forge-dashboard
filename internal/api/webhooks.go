package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// maxWebhookBodyBytes caps a webhook delivery's body well above any real
// GitHub/Forgejo payload — just enough to stop a misbehaving or malicious
// sender from streaming an unbounded body at an endpoint no session
// guards.
const maxWebhookBodyBytes = 5 << 20 // 5 MiB

// handleGitHubWebhook verifies a GitHub repository webhook delivery
// against its X-Hub-Signature-256 header and triggers an immediate
// refresh for the user webhookToken identifies.
func handleGitHubWebhook(store *settings.Store, manager *dashboard.Manager) http.HandlerFunc {
	return handleWebhook(store, manager, func(h http.Header) string {
		const prefix = "sha256="
		sig := h.Get("X-Hub-Signature-256")
		if len(sig) <= len(prefix) || sig[:len(prefix)] != prefix {
			return ""
		}
		return sig[len(prefix):]
	})
}

// handleForgejoWebhook verifies a Forgejo repository webhook delivery and
// triggers an immediate refresh for the user webhookToken identifies.
// Which header carries the signature depends on whether the webhook was
// set up with the "Forgejo" type or the legacy "Gitea" one — both are the
// same raw hex HMAC-SHA256, no prefix.
func handleForgejoWebhook(store *settings.Store, manager *dashboard.Manager) http.HandlerFunc {
	return handleWebhook(store, manager, func(h http.Header) string {
		if sig := h.Get("X-Forgejo-Signature"); sig != "" {
			return sig
		}
		return h.Get("X-Gitea-Signature")
	})
}

// handleWebhook is what handleGitHubWebhook and handleForgejoWebhook
// share: look up the user by the path token, verify the body against
// their webhook secret using whatever signatureOf extracts from the
// request's headers, and refresh on success. Every event a tracked
// repo's webhook can send — a new pull request, a closed issue, a CI
// status change, even the "ping" event sent when the webhook is first
// created — means the same thing here, so nothing about the payload
// itself is parsed.
func handleWebhook(store *settings.Store, manager *dashboard.Manager, signatureOf func(http.Header) string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("webhookToken")

		userID, secret, err := store.FindByWebhookToken(r.Context(), token)
		if errors.Is(err, settings.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errorBody("unknown webhook token"))
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not look up webhook token"))
			return
		}

		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBodyBytes))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("could not read request body"))
			return
		}

		if !validSignature(body, secret, signatureOf(r.Header)) {
			writeJSON(w, http.StatusUnauthorized, errorBody("invalid webhook signature"))
			return
		}

		manager.RefreshNow(r.Context(), userID)
		w.WriteHeader(http.StatusNoContent)
	}
}

func validSignature(body []byte, secret, signatureHex string) bool {
	if signatureHex == "" {
		return false
	}
	sig, err := hex.DecodeString(signatureHex)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(sig, mac.Sum(nil))
}
