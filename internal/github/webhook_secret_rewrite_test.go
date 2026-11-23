package github_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const rewriteTarget = "https://dashboard.example/api/webhooks/github/tok123"

// hookServer counts every request to a repo's hooks and keeps the last PATCH.
type hookServer struct {
	*httptest.Server

	lists, patches, posts atomic.Int32
	patch                 struct {
		Config map[string]any `json:"config"`
		Events []string       `json:"events"`
		Active bool           `json:"active"`
	}
}

func newHookServer(t *testing.T, hooks []map[string]any) *hookServer {
	t.Helper()
	h := &hookServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			h.posts.Add(1)
			writeJSON(t, w, map[string]any{"id": 99})

			return
		}
		h.lists.Add(1)
		writeJSON(t, w, hooks)
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks/7", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPatch, r.Method)
		h.patches.Add(1)
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&h.patch))
		writeJSON(t, w, map[string]any{"id": 7})
	})
	h.Server = httptest.NewServer(mux)
	t.Cleanup(h.Close)

	return h
}

func TestRewriteWebhookSecret_UpToDateHook_IsStillPatchedWithTheNewSecret(t *testing.T) {
	t.Parallel()

	srv := newHookServer(t, []map[string]any{
		{"id": 7, "active": true, "config": map[string]any{"url": rewriteTarget}, "events": []string{
			"pull_request", "issues", "issue_comment", "pull_request_review", "pull_request_review_comment",
			"pull_request_review_thread", "status", "check_run",
		}},
	})

	rewritten, err := github.NewClient("test-token", "", srv.URL).RewriteWebhookSecret(t.Context(), "alrayyes", "a", rewriteTarget, "new-secret")

	require.NoError(t, err)
	assert.True(t, rewritten)
	assert.EqualValues(t, 1, srv.patches.Load())
	assert.Equal(t, "new-secret", srv.patch.Config["secret"])
	assert.EqualValues(t, 0, srv.posts.Load(), "no second hook")
}

func TestRewriteWebhookSecret_NoHookOfOurs_CreatesNothing(t *testing.T) {
	t.Parallel()

	srv := newHookServer(t, []map[string]any{})

	rewritten, err := github.NewClient("test-token", "", srv.URL).RewriteWebhookSecret(t.Context(), "alrayyes", "a", rewriteTarget, "new-secret")

	require.NoError(t, err)
	assert.False(t, rewritten)
	assert.EqualValues(t, 0, srv.posts.Load()+srv.patches.Load())
}

func TestRewriteWebhookSecret_RateLimited_ReturnsTheClassifiedError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := github.NewClient("test-token", "", srv.URL).RewriteWebhookSecret(t.Context(), "alrayyes", "a", rewriteTarget, "new-secret")

	require.Error(t, err)
}
