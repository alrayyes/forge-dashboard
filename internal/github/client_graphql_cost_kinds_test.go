package github_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// costAwareGitHub answers like GitHub does: the rateLimit block is in the
// reply only when the query asked for it. A stand-in that always sent it would
// hide a query that never asks.
func costAwareGitHub(t *testing.T) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Query string `json:"query"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)

			return
		}

		data := map[string]any{
			"viewer": map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false, "endCursor": ""},
				"nodes":    []map[string]any{},
			}},
			"repository": map[string]any{
				"url":          "https://github.com/alrayyes/a",
				"pullRequests": map[string]any{"nodes": []map[string]any{}},
				"issues":       map[string]any{"nodes": []map[string]any{}},
				"pullRequest":  map[string]any{"comments": map[string]any{"nodes": []map[string]any{}}},
				"issue":        map[string]any{"comments": map[string]any{"nodes": []map[string]any{}}},
				"release":      map[string]any{"tagName": "v1", "publishedAt": "2026-09-14T16:00:00Z"},
			},
		}
		if strings.Contains(body.Query, "rateLimit") {
			data["rateLimit"] = map[string]any{"limit": 5000, "cost": 4, "remaining": 4996}
		}
		writeJSON(t, w, map[string]any{"data": data})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func TestGraphQLCost_EveryReadAKindMakesIsRecorded(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		kind apistats.Kind
		call func(ctx context.Context, t *testing.T, c *github.Client)
	}{
		{"full refresh", apistats.KindFull, func(ctx context.Context, t *testing.T, c *github.Client) {
			t.Helper()
			require.True(t, c.Fetch(ctx).Health.Reachable)
		}},
		{"CI poll", apistats.KindCIPoll, func(ctx context.Context, t *testing.T, c *github.Client) {
			t.Helper()
			_, err := c.RefreshPending(ctx, pendingRefs(1))
			require.NoError(t, err)
		}},
		{"scoped webhook repo refresh", apistats.KindScopedWebhook, func(ctx context.Context, t *testing.T, c *github.Client) {
			t.Helper()
			_, _, err := c.FetchRepo(ctx, "alrayyes", "a", "alrayyes/a")
			require.NoError(t, err)
		}},
		{"scoped webhook default-branch row", apistats.KindScopedWebhook, func(ctx context.Context, t *testing.T, c *github.Client) {
			t.Helper()
			_, err := c.FetchMainBranch(ctx, "alrayyes", "a", "alrayyes/a")
			require.NoError(t, err)
		}},
		{"pull request details", apistats.KindDetails, func(ctx context.Context, t *testing.T, c *github.Client) {
			t.Helper()
			_, err := c.GetPullRequestDetails(ctx, "alrayyes", "a", 1)
			require.NoError(t, err)
		}},
		{"issue details", apistats.KindDetails, func(ctx context.Context, t *testing.T, c *github.Client) {
			t.Helper()
			_, err := c.GetIssueDetails(ctx, "alrayyes", "a", 1)
			require.NoError(t, err)
		}},
		{"release details", apistats.KindDetails, func(ctx context.Context, t *testing.T, c *github.Client) {
			t.Helper()
			_, err := c.GetReleaseDetails(ctx, "alrayyes", "a", "v1")
			require.NoError(t, err)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			srv := costAwareGitHub(t)
			counters := apistats.New()
			client := github.NewClient("test-token", "", srv.URL)
			client.SetStats(counters, "token:abcd")

			ctx := apistats.WithRepo(apistats.WithKind(context.Background(), tc.kind), "alrayyes/a")
			tc.call(ctx, t, client)

			var got apistats.Count
			for _, b := range counters.Snapshot() {
				if b.Kind == tc.kind {
					got.GraphQL += b.GraphQL
					got.GraphQLCost += b.GraphQLCost
				}
			}
			assert.EqualValues(t, 1, got.GraphQL)
			assert.EqualValues(t, 4, got.GraphQLCost)
		})
	}
}
