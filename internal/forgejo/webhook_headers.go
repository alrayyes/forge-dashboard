package forgejo

import "net/http"

// WebhookSignature is the raw hex HMAC-SHA256 of a Forgejo delivery, with no
// prefix. Which header carries it depends on whether the webhook was set up
// with the "Forgejo" type or the legacy "Gitea" one, so the Forgejo header
// wins and the Gitea one is the fallback. Empty when neither is present.
func WebhookSignature(h http.Header) string {
	if sig := h.Get("X-Forgejo-Signature"); sig != "" {
		return sig
	}

	return h.Get("X-Gitea-Signature")
}

// WebhookDelivery reads a delivery's ID and event type, for logging only.
// Forgejo sends X-Forgejo-Delivery and X-Forgejo-Event, falling back to the
// Gitea-named pair for an instance whose webhook uses that older type, the
// same split WebhookSignature makes.
func WebhookDelivery(h http.Header) (id, event string) {
	id = h.Get("X-Forgejo-Delivery")
	if id == "" {
		id = h.Get("X-Gitea-Delivery")
	}
	event = h.Get("X-Forgejo-Event")
	if event == "" {
		event = h.Get("X-Gitea-Event")
	}

	return id, event
}
