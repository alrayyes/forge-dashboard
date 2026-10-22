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

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// maxWebhookBodyBytes caps a webhook delivery's body well above any real
// GitHub/Forgejo payload — just enough to stop a misbehaving or malicious
// sender from streaming an unbounded body at an endpoint no session
// guards.
const maxWebhookBodyBytes = 5 << 20 // 5 MiB

// ownerFinder names the one user a verified webhook delivery acts for. The
// delivery carries no session, and the dashboard it refreshes is still keyed by
// user id.
type ownerFinder interface {
	OwnerID(ctx context.Context) ([]byte, error)
}

// handleGitHubWebhook verifies a GitHub repository webhook delivery
// against its X-Hub-Signature-256 header and triggers an immediate
// refresh for the one user when webhookToken matches.
func handleGitHubWebhook(appCtx context.Context, store *settings.Store, owners ownerFinder, manager *dashboard.Manager) http.HandlerFunc {
	return handleWebhook(appCtx, store, owners, manager, dashboard.ForgeGitHub,
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
// triggers an immediate refresh for the one user when webhookToken matches.
// Which header carries the signature depends on whether the webhook was
// set up with the "Forgejo" type or the legacy "Gitea" one — both are the
// same raw hex HMAC-SHA256, no prefix.
func handleForgejoWebhook(appCtx context.Context, store *settings.Store, owners ownerFinder, manager *dashboard.Manager) http.HandlerFunc {
	return handleWebhook(appCtx, store, owners, manager, dashboard.ForgeForgejo,
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

// pullRequestEvent is a pull_request delivery's own account of what happened
// to a pull request. GitHub and Forgejo share the shape.
type pullRequestEvent struct {
	Action      string `json:"action"`
	PullRequest *struct {
		Number int `json:"number"`
	} `json:"pull_request"`
}

// pullRequestAction returns the action and number of the pull request a
// delivery is about, or ok false for any other event. It reads the body
// rather than the event header: the body is what the signature covers.
func pullRequestAction(body []byte) (action string, number int, ok bool) {
	var ev pullRequestEvent
	if err := json.Unmarshal(body, &ev); err != nil || ev.PullRequest == nil || ev.PullRequest.Number == 0 {
		return "", 0, false
	}

	return ev.Action, ev.PullRequest.Number, true
}

// checkEvent is the shape of the three check events: each names the commit its
// checks ran against, in a different place.
type checkEvent struct {
	CheckRun *struct {
		HeadSHA string `json:"head_sha"`
	} `json:"check_run"`
	CheckSuite *struct {
		HeadSHA string `json:"head_sha"`
	} `json:"check_suite"`
	SHA string `json:"sha"`
}

// checkCommit returns the commit a check delivery is about, read from the
// object that event is about, and false when the body is not that event. The
// signature covers the body but not the event header, so a signed body can be
// replayed under another header; a check event is only believed when its body
// names a commit where that event keeps it. A replayed comment, push or
// pull_request body then cannot pass for a check delivery.
func checkCommit(event string, body []byte) (string, bool) {
	var ev checkEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return "", false
	}
	var sha string
	switch event {
	case "check_run":
		if ev.CheckRun != nil {
			sha = ev.CheckRun.HeadSHA
		}
	case "check_suite":
		if ev.CheckSuite != nil {
			sha = ev.CheckSuite.HeadSHA
		}
	case "status":
		sha = ev.SHA
	}

	return sha, isCommitSHA(sha)
}

// isCommitSHA reports whether s looks like a git object id: 7 to 64 hex digits.
func isCommitSHA(s string) bool {
	if len(s) < 7 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return false
		}
	}

	return true
}

// recordDelivery notes a verified delivery with the dashboard. A check event
// whose body backs it up marks its commit; one whose body does not is recorded
// as an event of no particular class.
func recordDelivery(manager *dashboard.Manager, userID []byte, forge dashboard.Forge, fullName, event string, body []byte) {
	if dashboard.ClassifyEvent(event) != dashboard.EventClassCheck {
		manager.RecordDelivery(userID, forge, fullName, event)

		return
	}
	if sha, ok := checkCommit(event, body); ok {
		manager.RecordCheckDelivery(userID, forge, fullName, sha)

		return
	}
	manager.RecordDelivery(userID, forge, fullName, "")
}

// settleFromDelivery applies what a signed pull_request delivery says about
// the pull request's state before any fetch can: closed (merged or not) takes
// it off the board, reopened lets the next fetch bring it back. The fetch that
// follows is not trusted to agree yet. A forge's list can go on showing a pull
// request as open for a while after it merged, and a failed fetch shows
// nothing at all, either of which kept a merged pull request's Merge button on
// the board (#966). Dropped by the aggregator once a fetch stops listing it.
func settleFromDelivery(manager *dashboard.Manager, userID []byte, forge dashboard.Forge, body []byte) {
	_, _, fullName, ok := repoFromPayload(body)
	if !ok {
		return
	}
	action, number, ok := pullRequestAction(body)
	if !ok {
		return
	}
	switch action {
	case "closed":
		manager.MarkSettled(userID, forge, fullName, number)
	case "reopened":
		manager.Unsettle(userID, forge, fullName, number)
	}
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
func handleWebhook(appCtx context.Context, store *settings.Store, owners ownerFinder, manager *dashboard.Manager, forge dashboard.Forge, signatureOf func(http.Header) string, deliveryOf func(http.Header) (id, event string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("webhookToken")
		delivery, event := deliveryOf(r.Header)

		secret, err := store.WebhookSecretFor(r.Context(), token)
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
			if err := store.RecordWebhookDelivery(r.Context(), string(forge), fullName); err != nil {
				slog.Warn("recording webhook delivery failed", "forge", forge, "repo", fullName, "error", err)
			}
		}

		acknowledgeDelivery(appCtx, r, w, owners, manager, forge, delivery, event, body)
	}
}

// acknowledgeDelivery answers a verified delivery and starts the refresh it
// asks for on the owner's dashboard. With nobody registered there is no
// dashboard to refresh, and the delivery is still acknowledged: the sender
// can't act on that. Any other failure finding the owner is transient, so it
// answers 503 and the forge redelivers instead of the refresh being lost.
func acknowledgeDelivery(appCtx context.Context, r *http.Request, w http.ResponseWriter, owners ownerFinder, manager *dashboard.Manager, forge dashboard.Forge, delivery, event string, body []byte) {
	userID, err := owners.OwnerID(r.Context())
	if errors.Is(err, auth.ErrNotFound) {
		slog.Warn("webhook accepted but no owner to refresh", "forge", forge, "event", event, "delivery", delivery, "error", err)
		w.WriteHeader(http.StatusNoContent)

		return
	}
	if err != nil {
		slog.Error("webhook could not look up the owner, asking the sender to retry", "forge", forge, "event", event, "delivery", delivery, "error", err)
		w.WriteHeader(http.StatusServiceUnavailable)

		return
	}

	slog.Info("webhook accepted", "forge", forge, "event", event, "delivery", delivery)
	if _, _, fullName, ok := repoFromPayload(body); ok {
		recordDelivery(manager, userID, forge, fullName, event, body)
	}
	settleFromDelivery(manager, userID, forge, body)
	w.WriteHeader(http.StatusNoContent)
	go triggerRefresh(appCtx, manager, userID, forge, delivery, body)
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
//
// A scoped refresh is held back briefly and merged with the repo's other
// deliveries (Aggregator.RefreshRepoDebounced), because one push sends several
// deliveries in a burst. The fallback to a full refresh is not held back.
func triggerRefresh(ctx context.Context, manager *dashboard.Manager, userID []byte, forge dashboard.Forge, delivery string, body []byte) {
	if owner, name, fullName, ok := repoFromPayload(body); ok {
		// A failed fetch says which delivery and pull request it was for (#966).
		attrs := []any{"delivery", delivery}
		if _, number, isPR := pullRequestAction(body); isPR {
			attrs = append(attrs, "pull_request", number)
		}
		if manager.RefreshRepoDebounced(ctx, userID, forge, owner, name, fullName, attrs...) {
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
