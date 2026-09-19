package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
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
func handleGitHubWebhook(appCtx context.Context, store *settings.Store, manager *dashboard.Manager) http.HandlerFunc {
	return handleWebhook(appCtx, store, manager, dashboard.ForgeGitHub,
		func(h http.Header) string {
			const prefix = "sha256="
			sig := h.Get("X-Hub-Signature-256")
			if len(sig) <= len(prefix) || sig[:len(prefix)] != prefix {
				return ""
			}

			return sig[len(prefix):]
		},
		githubDeliveryHeaders,
	)
}

// handleForgejoWebhook verifies a Forgejo repository webhook delivery and
// triggers an immediate refresh for the user webhookToken identifies.
// Which header carries the signature depends on whether the webhook was
// set up with the "Forgejo" type or the legacy "Gitea" one — both are the
// same raw hex HMAC-SHA256, no prefix.
func handleForgejoWebhook(appCtx context.Context, store *settings.Store, manager *dashboard.Manager) http.HandlerFunc {
	return handleWebhook(appCtx, store, manager, dashboard.ForgeForgejo,
		func(h http.Header) string {
			if sig := h.Get("X-Forgejo-Signature"); sig != "" {
				return sig
			}

			return h.Get("X-Gitea-Signature")
		},
		forgejoDeliveryHeaders,
	)
}

// githubDeliveryHeaders reads the two headers every real GitHub delivery
// carries — a stable ID and the event type — purely for logging; neither
// is trusted for anything security- or behavior-relevant.
func githubDeliveryHeaders(h http.Header) (delivery, event string) {
	return h.Get("X-GitHub-Delivery"), h.Get("X-GitHub-Event")
}

// forgejoDeliveryHeaders is githubDeliveryHeaders' Forgejo counterpart.
// Forgejo sends its own X-Forgejo-Delivery/X-Forgejo-Event pair, falling
// back to the legacy Gitea-named headers for an instance whose webhook
// was set up with that older type — the same distinction
// handleForgejoWebhook's own signature header already makes.
func forgejoDeliveryHeaders(h http.Header) (delivery, event string) {
	delivery = h.Get("X-Forgejo-Delivery")
	if delivery == "" {
		delivery = h.Get("X-Gitea-Delivery")
	}
	event = h.Get("X-Forgejo-Event")
	if event == "" {
		event = h.Get("X-Gitea-Event")
	}

	return delivery, event
}

// webhookPayload is the piece of a webhook delivery's body every event
// that carries a repository (which is almost all of them — a few, like
// "ping", don't) shares. Forgejo models its webhook payloads on GitHub's
// own for the same reason its REST API does, so one shape covers both.
type webhookPayload struct {
	Repository struct {
		FullName string `json:"full_name"`
		Name     string `json:"name"`
		Owner    struct {
			Login string `json:"login"`
		} `json:"owner"`
	} `json:"repository"`
}

// repoFromPayload extracts the repository a webhook delivery names, if
// its body has one — a malformed body already failed signature
// verification before this runs, so a parse failure here just means an
// event shape with no repository (a "ping", most likely), not a real
// error.
func repoFromPayload(body []byte) (owner, name, fullName string, ok bool) {
	var payload webhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", "", "", false
	}
	r := payload.Repository
	if r.FullName == "" || r.Name == "" || r.Owner.Login == "" {
		return "", "", "", false
	}

	return r.Owner.Login, r.Name, r.FullName, true
}

// handleWebhook is what handleGitHubWebhook and handleForgejoWebhook
// share: look up the user by the path token, verify the body against
// their webhook secret using whatever signatureOf extracts from the
// request's headers, and refresh on success.
//
// Every delivery is logged, verified or not — the only way to answer "did
// my webhook even arrive" from the process's own logs instead of
// reasoning about the code from the outside, the same motivation
// LOG_LEVEL's own request logging exists for. deliveryOf's id and event
// aren't trusted for anything security- or behavior-relevant, purely
// diagnostic — a delivery with neither still gets handled exactly the
// same way, just logged with them blank.
//
// The refresh runs in the background against appCtx (the process's own
// long-lived context), not r.Context() — confirmed live: an account with
// enough tracked repos can take longer to refresh than the sender is
// willing to wait, and a sender that gives up closes the connection,
// which cancels r.Context() and would have aborted every still-in-flight
// forge fetch along with it. The delivery is acknowledged as soon as it's
// verified; the refresh it triggers survives the delivery ending either
// way.
func handleWebhook(appCtx context.Context, store *settings.Store, manager *dashboard.Manager, forge dashboard.Forge, signatureOf func(http.Header) string, deliveryOf func(http.Header) (id, event string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("webhookToken")
		delivery, event := deliveryOf(r.Header)

		userID, secret, err := store.FindByWebhookToken(r.Context(), token)
		if errors.Is(err, settings.ErrNotFound) {
			slog.Warn("webhook token unknown", "forge", forge, "event", event, "delivery", delivery)
			writeJSON(w, http.StatusNotFound, errorBody("unknown webhook token"))

			return
		}
		if err != nil {
			slog.Warn("webhook token lookup failed", "forge", forge, "event", event, "delivery", delivery, "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody("could not look up webhook token"))

			return
		}

		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBodyBytes))
		if err != nil {
			slog.Warn("webhook body unreadable", "forge", forge, "event", event, "delivery", delivery, "error", err)
			writeJSON(w, http.StatusBadRequest, errorBody("could not read request body"))

			return
		}

		if !validSignature(body, secret, signatureOf(r.Header)) {
			slog.Warn("webhook signature invalid", "forge", forge, "event", event, "delivery", delivery)
			writeJSON(w, http.StatusUnauthorized, errorBody("invalid webhook signature"))

			return
		}

		if _, _, fullName, ok := repoFromPayload(body); ok {
			if err := store.RecordWebhookDelivery(r.Context(), userID, string(forge), fullName); err != nil {
				slog.Warn("recording webhook delivery failed", "forge", forge, "repo", fullName, "error", err)
			}
		}

		slog.Info("webhook accepted", "forge", forge, "event", event, "delivery", delivery)
		w.WriteHeader(http.StatusNoContent)
		go triggerRefresh(appCtx, manager, userID, forge, delivery, body)
	}
}

// triggerRefresh scopes a webhook-triggered refresh to just the repo the
// payload names, when it can — a webhook for one repo used to refresh a
// user's entire tracked-repo set across both forges, real incident:
// exhausting the account's shared GitHub rate-limit budget on an account
// with many webhooked repos and real activity across them. Falls back to
// a full RefreshNow whenever it can't: an unparseable or repository-less
// payload (a "ping" delivery, most likely), or a forge whose Source
// doesn't support a scoped fetch yet (Aggregator.RefreshRepo's own
// RepoRefresher check) — a repo should never go unrefreshed just because
// the scoped path couldn't be taken.
func triggerRefresh(ctx context.Context, manager *dashboard.Manager, userID []byte, forge dashboard.Forge, delivery string, body []byte) {
	if owner, name, fullName, ok := repoFromPayload(body); ok {
		if manager.RefreshRepo(ctx, userID, forge, owner, name, fullName) {
			slog.Info("webhook refresh dispatched", "forge", forge, "delivery", delivery, "repo", fullName, "scoped", true)

			return
		}
		slog.Info("webhook scoped refresh unavailable, falling back to a full refresh", "forge", forge, "delivery", delivery, "repo", fullName)
	}
	ok := manager.RefreshNow(ctx, userID)
	slog.Info("webhook refresh dispatched", "forge", forge, "delivery", delivery, "scoped", false, "ok", ok)
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
