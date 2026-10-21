package github_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func hookEventsServer(t *testing.T, events []string) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{repoNodeWithOwnerName()},
					},
				},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{
			{"id": 1, "events": []string{"push"}, "config": map[string]any{"url": "https://elsewhere.example/hook"}},
			{"id": 2, "events": events, "config": map[string]any{"url": "https://dashboard.example/api/webhooks/github/tok123"}},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func TestFetch_WebhookCheck_RemembersTheOwnHooksEvents(t *testing.T) {
	t.Parallel()

	srv := hookEventsServer(t, []string{"pull_request", "check_run"})
	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath("/api/webhooks/github/tok123")
	client.Fetch(t.Context())

	events, confirmed := client.WebhookEvents("alrayyes/a")

	assert.True(t, confirmed)
	assert.Equal(t, []string{"pull_request", "check_run"}, events)
}

func TestWebhookEvents_BeforeAnyCheck_IsNotConfirmed(t *testing.T) {
	t.Parallel()

	client := github.NewClient("test-token", "", "http://127.0.0.1:1")
	client.SetWebhookPath("/api/webhooks/github/tok123")

	_, confirmed := client.WebhookEvents("alrayyes/a")

	assert.False(t, confirmed)
}

func TestFetch_WebhookCheck_RepoWithoutOwnHookIsNotConfirmed(t *testing.T) {
	t.Parallel()

	srv := hookEventsServer(t, nil)
	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath("/api/webhooks/github/other")
	client.Fetch(t.Context())

	_, confirmed := client.WebhookEvents("alrayyes/a")

	assert.False(t, confirmed)
}

func TestClient_CredentialLabel_IsTheStatsLabelAndNeverTheToken(t *testing.T) {
	t.Parallel()

	client := github.NewClient("secret-token", "", "http://127.0.0.1:1")
	client.SetStats(apistats.New(), apistats.TokenCredential("secret-token"))

	label := client.CredentialLabel()

	require.NotEmpty(t, label)
	assert.NotContains(t, label, "secret-token")
}
