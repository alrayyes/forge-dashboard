package forgejo_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const rewriteTarget = "https://dashboard.example/api/webhooks/forgejo/tok123"

func rewriteServer(t *testing.T, hooks []map[string]any, patches, posts *atomic.Int32, patch *struct {
	Config map[string]string `json:"config"`
},
) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			w.WriteHeader(http.StatusCreated)
			writeJSON(t, w, map[string]any{"id": 99})

			return
		}
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, hooks)
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/hooks/7", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPatch, r.Method)
		patches.Add(1)
		assert.NoError(t, json.NewDecoder(r.Body).Decode(patch))
		w.WriteHeader(http.StatusOK)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func TestRewriteWebhookSecret_UpToDateHook_IsStillPatchedWithTheNewSecret(t *testing.T) {
	t.Parallel()

	var patches, posts atomic.Int32
	var patch struct {
		Config map[string]string `json:"config"`
	}
	srv := rewriteServer(t, []map[string]any{
		{"id": 7, "type": "forgejo", "active": true, "config": map[string]string{"url": rewriteTarget}, "events": []string{
			"pull_request", "issues", "issue_comment", "pull_request_comment", "pull_request_review_comment",
			"pull_request_review_approved", "pull_request_review_rejected", "push", "status",
			"action_run_failure", "action_run_success",
		}},
	}, &patches, &posts, &patch)

	rewritten, err := forgejo.NewClient(srv.URL, "test-token", "").RewriteWebhookSecret(t.Context(), "alrayyes", "a", rewriteTarget, "new-secret")

	require.NoError(t, err)
	assert.True(t, rewritten)
	assert.EqualValues(t, 1, patches.Load())
	assert.Equal(t, "new-secret", patch.Config["secret"])
	assert.EqualValues(t, 0, posts.Load(), "no second hook")
}

func TestRewriteWebhookSecret_NoHookOfOurs_CreatesNothing(t *testing.T) {
	t.Parallel()

	var patches, posts atomic.Int32
	var patch struct {
		Config map[string]string `json:"config"`
	}
	srv := rewriteServer(t, []map[string]any{}, &patches, &posts, &patch)

	rewritten, err := forgejo.NewClient(srv.URL, "test-token", "").RewriteWebhookSecret(t.Context(), "alrayyes", "a", rewriteTarget, "new-secret")

	require.NoError(t, err)
	assert.False(t, rewritten)
	assert.EqualValues(t, 0, patches.Load()+posts.Load())
}

func TestRewriteWebhookSecret_RateLimited_ReturnsARateLimitedClientError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	t.Cleanup(srv.Close)

	rewritten, err := forgejo.NewClient(srv.URL, "test-token", "").RewriteWebhookSecret(t.Context(), "alrayyes", "a", rewriteTarget, "new-secret")

	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorRateLimited, clientErr.Kind)
	assert.False(t, rewritten)
}

func TestRewriteWebhookSecret_InvalidTargetURL_DoesNotEchoTheWebhookToken(t *testing.T) {
	t.Parallel()

	_, err := forgejo.NewClient("http://unused.invalid", "test-token", "").
		RewriteWebhookSecret(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/forgejo/tok123\x7f", "s")

	require.Error(t, err)
	assert.NotContains(t, err.Error(), "tok123")
}
