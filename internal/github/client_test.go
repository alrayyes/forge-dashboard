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

// writeJSON runs inside the httptest server's own goroutine, not the test
// goroutine — assert.NoError (Errorf under the hood), never require
// (FailNow/Goexit), which testing's own docs restrict to the test's
// goroutine.
func writeJSON(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	assert.NoError(t, json.NewEncoder(w).Encode(v))
}

func TestListRepos_FiltersToPushAccessAndPaginates(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/user/repos", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("page") {
		case "1":
			writeJSON(t, w, []map[string]any{
				{"full_name": "alrayyes/a", "name": "a", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": true}},
				{"full_name": "alrayyes/read-only", "name": "read-only", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": false}},
			})
		default:
			writeJSON(t, w, []map[string]any{})
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	repos, err := client.ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, "alrayyes/a", repos[0].FullName)
}

func TestListRepos_ExcludesArchivedAndForkedRepos(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/user/repos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/active", "name": "active", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": true}, "archived": false, "fork": false},
			{"full_name": "alrayyes/archived", "name": "archived", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": true}, "archived": true, "fork": false},
			{"full_name": "alrayyes/forked", "name": "forked", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": true}, "archived": false, "fork": true},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	repos, err := client.ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, "alrayyes/active", repos[0].FullName)
}

func TestListRepos_NoToken_FallsBackToUsernamesPublicRepos(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/users/alrayyes/repos", func(w http.ResponseWriter, r *http.Request) {
		assert.Empty(t, r.Header.Get("Authorization"), "the public fallback should never send a credential")
		assert.Equal(t, "owner", r.URL.Query().Get("type"))
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			// No "permissions" field at all — GitHub omits it entirely on
			// an unauthenticated request.
			{"full_name": "alrayyes/hush-hush", "name": "hush-hush", "owner": map[string]string{"login": "alrayyes"}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("", "alrayyes", srv.URL)
	repos, err := client.ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, "alrayyes/hush-hush", repos[0].FullName)
}

func TestListRepos_NoToken_ExcludesArchivedAndForkedRepos(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/users/alrayyes/repos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/active", "name": "active", "owner": map[string]string{"login": "alrayyes"}, "archived": false, "fork": false},
			{"full_name": "alrayyes/archived", "name": "archived", "owner": map[string]string{"login": "alrayyes"}, "archived": true, "fork": false},
			{"full_name": "alrayyes/forked", "name": "forked", "owner": map[string]string{"login": "alrayyes"}, "archived": false, "fork": true},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("", "alrayyes", srv.URL)
	repos, err := client.ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, "alrayyes/active", repos[0].FullName)
}

func TestListRepos_NeitherTokenNorUsername_Errors(t *testing.T) {
	t.Parallel()

	client := github.NewClient("", "", "http://unused.invalid")
	_, err := client.ListRepos(t.Context())

	require.Error(t, err)
}

func TestListRepos_ErrorIncludesAPIMessage(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/user/repos", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]string{"message": "API rate limit exceeded for user ID 511318."})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	_, err := client.ListRepos(t.Context())

	require.Error(t, err)
	assert.Contains(t, err.Error(), "API rate limit exceeded for user ID 511318.")
}

func TestListRepos_RateLimitErrorIncludesResetTime(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/user/repos", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "1789395740")
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]string{"message": "API rate limit exceeded."})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	_, err := client.ListRepos(t.Context())

	require.Error(t, err)
	assert.Contains(t, err.Error(), "resets")
}

func TestListRepos_RetryAfterIncludedWhenPresent(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/user/repos", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "42")
		w.WriteHeader(http.StatusTooManyRequests)
		writeJSON(t, w, map[string]string{"message": "You have exceeded a secondary rate limit."})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	_, err := client.ListRepos(t.Context())

	require.Error(t, err)
	assert.Contains(t, err.Error(), "retry after 42s")
}

func TestListOpenPullRequests_MapsFieldsAndResolvesCIFromCheckRuns(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "1" {
			writeJSON(t, w, []map[string]any{
				{
					"number": 42, "title": "Add widget", "html_url": "https://github.com/alrayyes/a/pull/42",
					"draft": true, "user": map[string]string{"login": "ryankes"},
					"labels":     []map[string]string{{"name": "enhancement", "color": "a2eeef"}},
					"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
					"head": map[string]string{"sha": "deadbeef"},
				},
			})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/deadbeef/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"check_runs": []map[string]string{
				{"status": "completed", "conclusion": "failure"},
				{"status": "completed", "conclusion": "success"},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	prs, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, prs, 1)
	pr := prs[0]

	t.Run("basic fields", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, 42, pr.Number)
		assert.Equal(t, "Add widget", pr.Title)
		assert.True(t, pr.Draft)
		assert.Equal(t, "ryankes", pr.Author)
	})
	t.Run("labels carry through", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, []dashboard.Label{{Name: "enhancement", Color: "a2eeef"}}, pr.Labels)
	})
	t.Run("CI reflects the failed check run", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, dashboard.CIFailure, pr.CI)
	})
}

func TestListOpenPullRequests_FallsBackToCombinedStatusWhenNoCheckRuns(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "1" {
			writeJSON(t, w, []map[string]any{
				{"number": 1, "title": "x", "html_url": "https://x", "user": map[string]string{"login": "u"}, "head": map[string]string{"sha": "sha1"}},
			})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/sha1/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": []map[string]string{}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/sha1/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]string{"state": "pending"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	prs, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, prs, 1)
	assert.Equal(t, dashboard.CIPending, prs[0].CI)
}

func TestListOpenIssues_ExcludesPullRequests(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/issues", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "1" {
			writeJSON(t, w, []map[string]any{
				{"number": 1, "title": "a real issue", "html_url": "https://x/1", "user": map[string]string{"login": "u"}},
				{"number": 2, "title": "actually a PR", "html_url": "https://x/2", "user": map[string]string{"login": "u"}, "pull_request": map[string]string{"url": "https://x"}},
			})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	issues, err := client.ListOpenIssues(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, issues, 1)
	assert.Equal(t, 1, issues[0].Number)
}
