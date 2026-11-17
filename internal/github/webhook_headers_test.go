package github_test

import (
	"net/http"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
)

func TestWebhookSignature(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   string
	}{
		{"prefixed hex", "sha256=abc123", "abc123"},
		{"missing", "", ""},
		{"prefix only", "sha256=", ""},
		{"wrong prefix", "sha1=abc123", ""},
		{"no prefix", "abc123", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := http.Header{}
			if tt.header != "" {
				h.Set("X-Hub-Signature-256", tt.header)
			}
			if got := github.WebhookSignature(h); got != tt.want {
				t.Errorf("WebhookSignature = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestWebhookDelivery(t *testing.T) {
	h := http.Header{}
	h.Set("X-GitHub-Delivery", "id-1")
	h.Set("X-GitHub-Event", "push")
	id, event := github.WebhookDelivery(h)
	if id != "id-1" || event != "push" {
		t.Errorf("WebhookDelivery = %q, %q", id, event)
	}
	id, event = github.WebhookDelivery(http.Header{})
	if id != "" || event != "" {
		t.Errorf("empty headers gave %q, %q", id, event)
	}
}
