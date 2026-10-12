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

// alrayyes/cloudflare-wrangler: attempt 1 of a push to main failed, attempt 2
// passed, and the check_run delivery for the rerun has to turn the row green
// (#1316).
func TestFetchMainBranch_ReadsTheDefaultBranchOfOneRepo(t *testing.T) {
	t.Parallel()

	var asked map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		asked = body.Variables
		assert.Contains(t, body.Query, "defaultBranchRef")
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"repository": map[string]any{
				"url": "https://github.com/alrayyes/a",
				"defaultBranchRef": map[string]any{
					"name": "main",
					"target": map[string]any{
						"oid": "8ca711fb3028702fc572418e7bbb02b453c2c6b6", "abbreviatedOid": "8ca711f",
						"messageHeadline": "fix: a thing", "url": "https://github.com/alrayyes/a/commit/8ca711f",
						"committedDate":     "2026-10-12T12:57:00Z",
						"statusCheckRollup": rollupFixture("SUCCESS", map[string]int{"SUCCESS": 8}, nil),
					},
				},
			},
		}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	row, err := github.NewClient("test-token", "", srv.URL).FetchMainBranch(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	assert.Equal(t, "alrayyes", asked["owner"])
	assert.Equal(t, "a", asked["name"])
	assert.Equal(t, dashboard.ForgeGitHub, row.Forge)
	assert.Equal(t, "alrayyes/a", row.FullName)
	assert.Equal(t, "https://github.com/alrayyes/a", row.URL)
	assert.Equal(t, "main", row.Branch)
	assert.Equal(t, dashboard.MainBranchPassed, row.Status)
}

func TestFetchMainBranch_AnUnknownRepositoryIsAnError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": nil}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := github.NewClient("test-token", "", srv.URL).FetchMainBranch(t.Context(), "alrayyes", "gone", "alrayyes/gone")

	require.Error(t, err)
}
