package github

import "net/http"

// WebhookSignature is the hex HMAC-SHA256 a GitHub delivery carries in
// X-Hub-Signature-256, with its "sha256=" prefix removed. Empty when the
// header is missing or isn't the sha256 form.
func WebhookSignature(h http.Header) string {
	const prefix = "sha256="
	sig := h.Get("X-Hub-Signature-256")
	if len(sig) <= len(prefix) || sig[:len(prefix)] != prefix {
		return ""
	}

	return sig[len(prefix):]
}

// WebhookDelivery reads the two headers every real GitHub delivery carries, a
// stable ID and the event type. They are for logging only; nothing trusts
// them for a security or behaviour decision.
func WebhookDelivery(h http.Header) (id, event string) {
	return h.Get("X-GitHub-Delivery"), h.Get("X-GitHub-Event")
}
