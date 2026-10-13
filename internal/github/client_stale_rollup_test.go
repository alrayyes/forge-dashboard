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

// stalePRNode is one pull request whose head is headOid and whose last commit,
// with its SUCCESS rollup, is commitOid (empty leaves the commit's id out).
func stalePRNode(mergeState, headOid, commitOid string) map[string]any {
	commit := map[string]any{"statusCheckRollup": rollupFixture("SUCCESS", map[string]int{"SUCCESS": 4}, nil)}
	if commitOid != "" {
		commit["oid"] = commitOid
	}

	return map[string]any{
		"number": 860, "title": "push", "url": "https://github.com/alrayyes/a/pull/860",
		"isDraft": false, "author": map[string]any{"login": "claude"},
		"labels":    map[string]any{"nodes": []map[string]any{}},
		"createdAt": "2026-10-13T12:00:00Z", "updatedAt": "2026-10-13T12:20:00Z",
		"mergeStateStatus": mergeState, "headRefOid": headOid, "baseRefName": "main",
		"commits": map[string]any{"nodes": []map[string]any{{"commit": commit}}},
	}
}

// staleRollupServer serves one pull request whose head is headOid and whose
// last commit, with its rollup, is commitOid (empty leaves the commit's id
// out). GitHub updates a pull request's commit list in a background job after a
// push, so one response can carry the new head and its BLOCKED merge state
// beside the previous commit's SUCCESS (#1311).
func staleRollupServer(t *testing.T, mergeState, headOid, commitOid string, queries *[]string) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if queries != nil && strings.Contains(body.Query, "statusCheckRollup") {
			*queries = append(*queries, body.Query)
		}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes": []map[string]any{{
							"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "ADMIN",
							"owner":        map[string]any{"login": "alrayyes"},
							"pullRequests": map[string]any{"nodes": []map[string]any{stalePRNode(mergeState, headOid, commitOid)}},
							"issues":       map[string]any{"nodes": []map[string]any{}},
						}},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func TestFetch_RollupOfAnEarlierCommit_IsPendingNotPassed(t *testing.T) {
	t.Parallel()

	srv := staleRollupServer(t, "BLOCKED", "newhead", "oldhead", nil)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CIPending, result.PullRequests[0].CI,
		"the rollup belongs to oldhead, not the pull request's head, so it says nothing about newhead")
}

func TestFetch_RollupOfTheHeadCommit_IsTrusted(t *testing.T) {
	t.Parallel()

	srv := staleRollupServer(t, "CLEAN", "samehead", "samehead", nil)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CISuccess, result.PullRequests[0].CI)
}

// A response that names no commit id can't be compared, so the rollup stands.
func TestFetch_RollupWithNoCommitId_IsTrusted(t *testing.T) {
	t.Parallel()

	srv := staleRollupServer(t, "CLEAN", "samehead", "", nil)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CISuccess, result.PullRequests[0].CI)
}

func TestFetch_AsksForTheCommitIdBesideTheRollup(t *testing.T) {
	t.Parallel()

	var queries []string
	srv := staleRollupServer(t, "CLEAN", "samehead", "samehead", &queries)

	github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.NotEmpty(t, queries)
	for _, q := range queries {
		assert.Regexp(t, `commit \{\s*oid\s+statusCheckRollup`, q, "every query that reads the rollup reads the commit's id with it")
	}
}

// A push webhook refreshes through FetchRepo's own query, the one most likely
// to be read just after a push, so it has to read the commit id and use it.
func TestFetchRepo_RollupOfAnEarlierCommit_IsPendingNotPassed(t *testing.T) {
	t.Parallel()

	var query string
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if q := readGraphQLRequest(t, r).Query; strings.Contains(q, "statusCheckRollup") {
			query = q
		}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"repository": map[string]any{
					"pullRequests": map[string]any{"nodes": []map[string]any{stalePRNode("BLOCKED", "newhead", "oldhead")}},
					"issues":       map[string]any{"nodes": []map[string]any{}},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prs, _, err := github.NewClient("test-token", "", srv.URL).FetchRepo(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, prs, 1)
	assert.Equal(t, dashboard.CIPending, prs[0].CI)
	assert.Regexp(t, `commit \{\s*oid\s+statusCheckRollup`, query)
}
