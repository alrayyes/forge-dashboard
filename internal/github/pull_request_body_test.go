package github_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPullRequestBody_ReadsAndWritesTheBodyViaTheEditEndpoint(t *testing.T) {
	t.Parallel()

	var editBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			writeJSON(t, w, map[string]any{"number": 5, "body": "- [ ] <!-- rebase-check -->x"})

			return
		}
		assert.Equal(t, http.MethodPatch, r.Method)
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&editBody))
		writeJSON(t, w, map[string]any{"number": 5})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	body, err := client.PullRequestBody(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	assert.Equal(t, "- [ ] <!-- rebase-check -->x", body)

	require.NoError(t, client.SetPullRequestBody(t.Context(), "alrayyes", "a", 5, "- [x] <!-- rebase-check -->x"))
	assert.Equal(t, "- [x] <!-- rebase-check -->x", editBody["body"])
	assert.NotContains(t, editBody, "state")
}
