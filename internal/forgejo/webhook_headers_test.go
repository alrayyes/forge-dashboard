package forgejo_test

import (
	"net/http"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/forgejo"
)

func TestWebhookSignature_PrefersForgejoHeaderThenFallsBackToGitea(t *testing.T) {
	h := http.Header{}
	h.Set("X-Gitea-Signature", "gitea")
	if got := forgejo.WebhookSignature(h); got != "gitea" {
		t.Errorf("fallback = %q, want gitea", got)
	}
	h.Set("X-Forgejo-Signature", "forgejo")
	if got := forgejo.WebhookSignature(h); got != "forgejo" {
		t.Errorf("preferred = %q, want forgejo", got)
	}
	if got := forgejo.WebhookSignature(http.Header{}); got != "" {
		t.Errorf("missing = %q, want empty", got)
	}
}

func TestWebhookDelivery_PrefersForgejoHeadersThenFallsBackToGitea(t *testing.T) {
	h := http.Header{}
	h.Set("X-Gitea-Delivery", "g-id")
	h.Set("X-Gitea-Event", "g-event")
	id, event := forgejo.WebhookDelivery(h)
	if id != "g-id" || event != "g-event" {
		t.Errorf("fallback = %q, %q", id, event)
	}
	h.Set("X-Forgejo-Delivery", "f-id")
	h.Set("X-Forgejo-Event", "f-event")
	id, event = forgejo.WebhookDelivery(h)
	if id != "f-id" || event != "f-event" {
		t.Errorf("preferred = %q, %q", id, event)
	}
}
