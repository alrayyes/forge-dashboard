package forgejo_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
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
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/a", "name": "a", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": true}},
			{"full_name": "alrayyes/read-only", "name": "read-only", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": false}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	repos, err := client.ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, "alrayyes/a", repos[0].FullName)
}

func TestListRepos_ExcludesArchivedAndForkedRepos(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, r *http.Request) {
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

	client := forgejo.NewClient(srv.URL, "test-token", "")
	repos, err := client.ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, "alrayyes/active", repos[0].FullName)
}

func TestListRepos_ExcludesMirroredRepos(t *testing.T) {
	t.Parallel()

	// alrayyes/backup-git-repos mirrors his GitHub repos into Forgejo for
	// backup — real repos, but their canonical home (and the one worth
	// polling for pull requests and issues) is GitHub. Confirmed live:
	// forge-dashboard polled a mirror's /pulls and /issues and got a 404
	// on every request, since a mirror has neither enabled.
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/active", "name": "active", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": true}, "mirror": false},
			{"full_name": "alrayyes/tempus-fugit", "name": "tempus-fugit", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": true}, "mirror": true},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	repos, err := client.ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, "alrayyes/active", repos[0].FullName)
}

func TestListRepos_NoToken_FallsBackToUsernamesPublicRepos(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/users/alrayyes/repos", func(w http.ResponseWriter, r *http.Request) {
		assert.Empty(t, r.Header.Get("Authorization"), "the public fallback should never send a credential")
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/tempus-fugit", "name": "tempus-fugit", "owner": map[string]string{"login": "alrayyes"}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "", "alrayyes")
	repos, err := client.ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, "alrayyes/tempus-fugit", repos[0].FullName)
}

func TestListRepos_NoToken_ExcludesArchivedAndForkedRepos(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/users/alrayyes/repos", func(w http.ResponseWriter, r *http.Request) {
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

	client := forgejo.NewClient(srv.URL, "", "alrayyes")
	repos, err := client.ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, "alrayyes/active", repos[0].FullName)
}

func TestListRepos_NoToken_ExcludesMirroredRepos(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/users/alrayyes/repos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/active", "name": "active", "owner": map[string]string{"login": "alrayyes"}, "mirror": false},
			{"full_name": "alrayyes/tempus-fugit", "name": "tempus-fugit", "owner": map[string]string{"login": "alrayyes"}, "mirror": true},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "", "alrayyes")
	repos, err := client.ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, "alrayyes/active", repos[0].FullName)
}

func TestListRepos_NeitherTokenNorUsername_Errors(t *testing.T) {
	t.Parallel()

	client := forgejo.NewClient("http://unused.invalid", "", "")
	_, err := client.ListRepos(t.Context())

	require.Error(t, err)
}

func TestListRepos_ErrorIncludesAPIMessage(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		writeJSON(t, w, map[string]string{"message": "token does not have at least one of the required scopes"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	_, err := client.ListRepos(t.Context())

	require.Error(t, err)
	assert.Contains(t, err.Error(), "token does not have at least one of the required scopes")
}

func TestListRepos_RetryAfterIncludedWhenPresent(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
		writeJSON(t, w, map[string]string{"message": "too many requests"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	_, err := client.ListRepos(t.Context())

	require.Error(t, err)
	assert.Contains(t, err.Error(), "retry after 30s")
}

func TestListRepos_ClassifiesErrorKind(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		statusCode int
		wantKind   dashboard.ForgeErrorKind
	}{
		{"unauthorized", http.StatusUnauthorized, dashboard.ForgeErrorUnauthorized},
		{"forbidden", http.StatusForbidden, dashboard.ForgeErrorUnauthorized},
		{"not found", http.StatusNotFound, dashboard.ForgeErrorNotFound},
		{"too many requests", http.StatusTooManyRequests, dashboard.ForgeErrorRateLimited},
		{"server error", http.StatusInternalServerError, dashboard.ForgeErrorUnknown},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.statusCode)
				writeJSON(t, w, map[string]string{"message": "boom"})
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			client := forgejo.NewClient(srv.URL, "test-token", "")
			_, err := client.ListRepos(t.Context())

			require.Error(t, err)
			var clientErr *dashboard.ClientError
			require.ErrorAs(t, err, &clientErr)
			assert.Equal(t, tt.wantKind, clientErr.Kind)
		})
	}
}

func TestListRepos_ClassifiesConnectionFailureAsUnreachable(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.NewServeMux())
	srv.Close() // nothing is listening on this URL anymore

	client := forgejo.NewClient(srv.URL, "test-token", "")
	_, err := client.ListRepos(t.Context())

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorUnreachable, clientErr.Kind)
}

func TestListOpenPullRequests_MapsFieldsAndResolvesCI(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{
				"number": 12, "title": "Add NTP alarm", "html_url": "https://git.example/alrayyes/a/pulls/12",
				"draft": false, "user": map[string]string{"login": "ryankes"},
				"labels":     []map[string]string{{"name": "topic/monitoring", "color": "1d76db"}},
				"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
				"head": map[string]string{"sha": "cafef00d"},
			},
		})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]string{"state": "success"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	prs, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, prs, 1)
	pr := prs[0]

	t.Run("basic fields", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, 12, pr.Number)
		assert.Equal(t, "Add NTP alarm", pr.Title)
		assert.Equal(t, "ryankes", pr.Author)
	})
	t.Run("labels carry through", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, []dashboard.Label{{Name: "topic/monitoring", Color: "1d76db"}}, pr.Labels)
	})
	t.Run("CI reflects the combined status", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, dashboard.CISuccess, pr.CI)
	})
}

func TestCIStatus_MapsWarningToPending(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"number": 1, "title": "x", "html_url": "https://x", "user": map[string]string{"login": "u"}, "head": map[string]string{"sha": "sha1"}},
		})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/sha1/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]string{"state": "warning"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	prs, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, prs, 1)
	assert.Equal(t, dashboard.CIPending, prs[0].CI)
}

func TestListOpenIssues_UsesTypeIssuesFilter(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "issues", r.URL.Query().Get("type"))
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"number": 7, "title": "a real issue", "html_url": "https://x/7", "user": map[string]string{"login": "u"}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	issues, err := client.ListOpenIssues(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, issues, 1)
	assert.Equal(t, 7, issues[0].Number)
}

// TestListOpenPullRequests_MapsMergeableToMergeStatus asserts the
// deliberately coarse mapping: false becomes MergeBlocked, never
// MergeConflicting — Forgejo computes this field via a background queue
// that upstream issues (go-gitea/gitea#22578, #25849) show can lag or get
// stuck stale, so this service can't confidently call it a real conflict.
// See design.md's Decisions in
// openspec/changes/archive/*/show-pr-merge-status. AutoMergeEnabled is
// always nil: the SDK has no read capability for that at all.
func TestListOpenPullRequests_MapsMergeableToMergeStatus(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		mergeable bool
		want      dashboard.MergeStatus
	}{
		{"mergeable true maps to Mergeable", true, dashboard.MergeMergeable},
		{"mergeable false maps to Blocked, not Conflicting", false, dashboard.MergeBlocked},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("page") != "1" {
					writeJSON(t, w, []map[string]any{})
					return
				}
				writeJSON(t, w, []map[string]any{
					{
						"number": 12, "title": "Add NTP alarm", "html_url": "https://git.example/alrayyes/a/pulls/12",
						"draft": false, "user": map[string]string{"login": "ryankes"},
						"labels": []map[string]string{}, "mergeable": tc.mergeable,
						"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
						"head": map[string]string{"sha": "cafef00d"},
					},
				})
			})
			mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(t, w, map[string]string{"state": "success"})
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			client := forgejo.NewClient(srv.URL, "test-token", "")
			prs, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")

			require.NoError(t, err)
			require.Len(t, prs, 1)
			assert.Equal(t, tc.want, prs[0].MergeStatus)
			assert.Nil(t, prs[0].AutoMergeEnabled)
		})
	}
}
