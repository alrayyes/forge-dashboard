package github_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// GitHub puts a GraphQL error's kind at the top of the entry
// ({"type": "NOT_FOUND", "message": ...}), not under "extensions", so a pull
// request that doesn't exist is a not-found and not an unclassified failure.
func TestGetPullRequestDetails_AMissingPullRequestIsANotFound(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data":   map[string]any{"repository": map[string]any{"pullRequest": nil}},
			"errors": []map[string]any{{"type": "NOT_FOUND", "message": "Could not resolve to a PullRequest with the number of 5."}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := github.NewClient("test-token", "", srv.URL).GetPullRequestDetails(t.Context(), "alrayyes", "a", 5)

	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}
