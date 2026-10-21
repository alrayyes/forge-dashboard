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

func releaseServer(t *testing.T, release map[string]any, queries *[]graphqlRequestBody) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if queries != nil {
			*queries = append(*queries, body)
		}
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{"release": release}}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func TestGetReleaseDetails_ReadsTheReleaseByTagInOneQuery(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	srv := releaseServer(t, map[string]any{
		"tagName": "v1.2.3", "name": "Spring cleaning", "url": "https://github.com/a/b/releases/tag/v1.2.3",
		"publishedAt": "2026-10-01T10:00:00Z", "description": "## Fixes\n- One.",
		"updatedAt":      "2026-10-01T10:00:00Z",
		"reactionGroups": []map[string]any{reactionGroup("THUMBS_UP", 2, "demo-a", "demo-b")},
	}, &queries)
	client := github.NewClient("test-token", "", srv.URL)

	got, err := client.GetReleaseDetails(t.Context(), "a", "b", "v1.2.3")

	require.NoError(t, err)
	require.Len(t, queries, 1)
	assert.Equal(t, "v1.2.3", queries[0].Variables["tag"])
	assert.Equal(t, "Spring cleaning", got.Name)
	assert.Equal(t, "## Fixes\n- One.", got.Notes.Text)
	assert.Equal(t, 2, got.Notes.Reactions.ThumbsUp.Count)
}

func TestGetReleaseDetails_NoSuchRelease_IsNotFound(t *testing.T) {
	t.Parallel()

	srv := releaseServer(t, nil, nil)
	client := github.NewClient("test-token", "", srv.URL)

	_, err := client.GetReleaseDetails(t.Context(), "a", "b", "v9")

	var ce *dashboard.ClientError
	require.ErrorAs(t, err, &ce)
	assert.Equal(t, dashboard.ForgeErrorNotFound, ce.Kind)
}
