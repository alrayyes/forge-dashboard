package github_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const issueAvatar = "https://avatars.example.com/u/7"

// An issue's selection asks for the author's avatar next to the login. The
// mock answers either way, so the query text is checked too.
const issueAuthorSelection = `issues\(.*?author \{\s*login\s+avatarUrl`

func avatarIssueNode() map[string]any {
	node := issueNode(1, "first")
	node["author"] = map[string]any{"login": "someone", "avatarUrl": issueAvatar}

	return node
}

// The full fetch batches every repo in one query, so it has to read each issue
// author's avatar there.
func TestFetch_CarriesTheIssueAuthorAvatar(t *testing.T) {
	t.Parallel()

	var query string
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if q := readGraphQLRequest(t, r).Query; strings.Contains(q, "issues(") {
			query = q
		}
		writeJSON(t, w, reposPage(repoNodeWithIssues("a", 1, []map[string]any{avatarIssueNode()})))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.Issues, 1)
	assert.Equal(t, issueAvatar, result.Issues[0].AuthorAvatarURL)
	assert.Regexp(t, issueAuthorSelection, strings.ReplaceAll(query, "\n", " "))
}

// A webhook refresh swaps one repo's issues in for the last full fetch, so its
// own query has to read the avatar too, or the row loses it until the next
// full fetch.
func TestFetchRepo_CarriesTheIssueAuthorAvatar(t *testing.T) {
	t.Parallel()

	var query string
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if q := readGraphQLRequest(t, r).Query; strings.Contains(q, "issues(") {
			query = q
		}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"repository": map[string]any{
					"pullRequests": map[string]any{"nodes": []map[string]any{}},
					"issues":       map[string]any{"nodes": []map[string]any{avatarIssueNode()}},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	_, issues, err := github.NewClient("test-token", "", srv.URL).FetchRepo(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, issues, 1)
	assert.Equal(t, issueAvatar, issues[0].AuthorAvatarURL)
	assert.Regexp(t, issueAuthorSelection, strings.ReplaceAll(query, "\n", " "))
}

// The App client runs its own batched query per installation, with its own
// issues selection.
func TestAppClient_Fetch_CarriesTheIssueAuthorAvatar(t *testing.T) {
	t.Parallel()

	var query string
	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID), func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"token": "installation-token-value", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("/installation/repositories", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "repositories": []map[string]any{
			{"name": "repo-one", "full_name": "alrayyes/repo-one", "html_url": "https://github.com/alrayyes/repo-one", "owner": map[string]any{"login": "alrayyes"}},
		}})
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if q := readGraphQLRequest(t, r).Query; strings.Contains(q, "issues(") {
			query = q
		}
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": map[string]any{"limit": 5000, "cost": 1, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
			"r0": map[string]any{
				"pullRequests": map[string]any{"nodes": []map[string]any{}},
				"issuesTotal":  map[string]any{"totalCount": 1},
				"issues":       map[string]any{"nodes": []map[string]any{avatarIssueNode()}},
			},
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	result := client.Fetch(t.Context())

	require.Len(t, result.Issues, 1)
	assert.Equal(t, issueAvatar, result.Issues[0].AuthorAvatarURL)
	assert.Regexp(t, issueAuthorSelection, strings.ReplaceAll(query, "\n", " "))
}

// Without a token the client falls back to the public REST endpoints, which
// carry the avatar as the user's avatar_url.
func TestFetch_RESTFallback_CarriesTheIssueAuthorAvatar(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/users/alrayyes/repos", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/a", "name": "a", "owner": map[string]string{"login": "alrayyes"}},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/pulls", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/a/issues", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{{
			"number": 1, "title": "first", "html_url": "https://github.com/alrayyes/a/issues/1",
			"user":       map[string]string{"login": "someone", "avatar_url": issueAvatar},
			"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	result := github.NewClient("", "alrayyes", srv.URL).Fetch(t.Context())

	require.Len(t, result.Issues, 1)
	assert.Equal(t, issueAvatar, result.Issues[0].AuthorAvatarURL)
}
