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

func TestReopenPullRequest_ReopensViaEditEndpoint(t *testing.T) {
	t.Parallel()

	var editBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPatch, r.Method)
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&editBody))
		writeJSON(t, w, map[string]any{"number": 5, "state": "open"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.ReopenPullRequest(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.NotNil(t, editBody)
	assert.Equal(t, "open", editBody["state"])
}

// GitHub answers 422 when the head branch was deleted or force-pushed since
// the close: the refusal must reach the caller as an error it can classify.
func TestReopenPullRequest_BranchDeleted_ReturnsTheForgesRefusal(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		writeJSON(t, w, map[string]any{"message": "Validation Failed"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.ReopenPullRequest(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorUnknown, clientErr.Kind)
}
