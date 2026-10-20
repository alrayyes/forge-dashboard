package github_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A webhook for a repo that was deleted makes the single-repo query answer
// NOT_FOUND. That is now classified as a not-found, and it must stay a logged
// refresh failure: the forge-health panel, whose not-found text blames the
// instance URL, is only for failing to list the account's repos.
func TestRefreshRepo_ADeletedRepoLeavesTheForgeHealthAlone(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(readGraphQLRequest(t, r).Query, "repository(owner: $owner") {
			writeJSON(t, w, reposQueryFixture(pullRequestNode("CLEAN")))

			return
		}
		writeJSON(t, w, map[string]any{
			"data":   map[string]any{"repository": nil},
			"errors": []map[string]any{{"type": "NOT_FOUND", "message": "Could not resolve to a Repository with the name 'alrayyes/a'."}},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	agg := dashboard.NewAggregator([]dashboard.Source{github.NewClient("test-token", "", srv.URL)})
	agg.Refresh(t.Context())

	agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")

	forges := agg.Get().Forges
	require.Len(t, forges, 1)
	assert.True(t, forges[0].Reachable)
	assert.Empty(t, forges[0].Error)
	assert.Empty(t, forges[0].ErrorKind)
}
