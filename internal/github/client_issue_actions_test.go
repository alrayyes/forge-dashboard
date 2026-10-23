package github_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIssueState_CloseAndReopenGoThroughTheIssueEditEndpoint(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name  string
		state string
		call  func(c *github.Client) error
	}{
		{"close", "closed", func(c *github.Client) error { return c.CloseIssue(t.Context(), "alrayyes", "a", 7) }},
		{"reopen", "open", func(c *github.Client) error { return c.ReopenIssue(t.Context(), "alrayyes", "a", 7) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var editBody map[string]any
			mux := http.NewServeMux()
			mux.HandleFunc("/repos/alrayyes/a/issues/7", func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, http.MethodPatch, r.Method)
				assert.NoError(t, json.NewDecoder(r.Body).Decode(&editBody))
				writeJSON(t, w, map[string]any{"number": 7, "state": tc.state})
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			require.NoError(t, tc.call(github.NewClient("test-token", "", srv.URL)))
			assert.Equal(t, tc.state, editBody["state"])
			assert.Len(t, editBody, 1, "only the state changes")
		})
	}
}

func TestCommentIssue_PostsTheBodyToTheIssueCommentsEndpoint(t *testing.T) {
	t.Parallel()

	var posted map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/issues/7/comments", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&posted))
		w.WriteHeader(http.StatusCreated)
		writeJSON(t, w, map[string]any{"id": 1, "body": "Fixed upstream."})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	err := github.NewClient("test-token", "", srv.URL).CommentIssue(t.Context(), "alrayyes", "a", 7, "Fixed upstream.")

	require.NoError(t, err)
	assert.Equal(t, "Fixed upstream.", posted["body"])
}

// A token or App installation without issue write access is answered 403; the
// refusal must reach the caller classified, so the dialog can lock its buttons.
func TestIssueActions_NoWriteAccess_ClassifiesAsUnauthorized(t *testing.T) {
	t.Parallel()

	refuse := func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]any{"message": "Resource not accessible by personal access token"})
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/issues/7", refuse)
	mux.HandleFunc("/repos/alrayyes/a/issues/7/comments", refuse)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	client := github.NewClient("test-token", "", srv.URL)

	for name, err := range map[string]error{
		"close":   client.CloseIssue(t.Context(), "alrayyes", "a", 7),
		"reopen":  client.ReopenIssue(t.Context(), "alrayyes", "a", 7),
		"comment": client.CommentIssue(t.Context(), "alrayyes", "a", 7, "hi"),
	} {
		var clientErr *dashboard.ClientError
		require.ErrorAs(t, err, &clientErr, name)
		assert.Equal(t, dashboard.ForgeErrorUnauthorized, clientErr.Kind, name)
		assert.Contains(t, clientErr.PermissionMessage, "Issues", name)
	}
}
