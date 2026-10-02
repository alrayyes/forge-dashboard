package forgejo_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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

func TestListRepos_CanManageWebhooksRequiresAdminNotJustPush(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/push-only", "name": "push-only", "html_url": "https://forge.example/alrayyes/push-only", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": true, "admin": false}},
			{"full_name": "alrayyes/admin", "name": "admin", "html_url": "https://forge.example/alrayyes/admin", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": true, "admin": true}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	repos, err := client.ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 2)
	byName := make(map[string]dashboard.RepoRef, len(repos))
	for _, r := range repos {
		byName[r.FullName] = r
	}
	assert.False(t, byName["alrayyes/push-only"].CanManageWebhooks, "push access alone shouldn't grant webhook management")
	assert.True(t, byName["alrayyes/admin"].CanManageWebhooks)
	assert.Equal(t, "https://forge.example/alrayyes/admin", byName["alrayyes/admin"].URL)
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

// TestListOpenPullRequests_MapsBehindFromBaseShaVsMergeBase is a
// regression test for a real finding: confirmed live against a Forgejo
// instance, mergeable stays true after a new commit lands on the base
// branch — Forgejo doesn't recompute it synchronously. Base.Sha (fetched
// live on every request) diverging from MergeBase (fixed at the PR's
// original common ancestor) is what actually reflects it, so Behind has
// to be derived from those, and it has to work even when mergeable is
// still (staleness-)reporting true.
func TestListOpenPullRequests_MapsBehindFromBaseShaVsMergeBase(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		baseSha   string
		mergeBase string
		want      bool
	}{
		{"base unchanged since merge-base: not behind", "abc123", "abc123", false},
		{"base has moved since merge-base: behind, even though mergeable", "def456", "abc123", true},
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
						"labels": []map[string]string{}, "mergeable": true,
						"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
						"head":       map[string]string{"sha": "cafef00d"},
						"base":       map[string]string{"sha": tc.baseSha},
						"merge_base": tc.mergeBase,
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
			assert.Equal(t, dashboard.MergeMergeable, prs[0].MergeStatus)
			assert.Equal(t, tc.want, prs[0].Behind)
		})
	}
}

// TestListOpenPullRequests_MapsEmptyFromDiffstat is a regression test for
// a real finding: confirmed live against a Forgejo instance, a pull
// request can be mergeable while its additions/deletions/changed_files
// all report 0 — its content already landed on the base branch some
// other route, so merging it would be an empty commit.
func TestListOpenPullRequests_MapsEmptyFromDiffstat(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name         string
		additions    *int
		deletions    *int
		changedFiles *int
		want         bool
	}{
		{"all zero: empty", new(0), new(0), new(0), true},
		{"real diff: not empty", new(3), new(1), new(2), false},
		{"one nil (instance doesn't report it): not empty", nil, new(0), new(0), false},
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
						"labels": []map[string]string{}, "mergeable": true,
						"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
						"head":      map[string]string{"sha": "cafef00d"},
						"additions": tc.additions, "deletions": tc.deletions, "changed_files": tc.changedFiles,
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
			assert.Equal(t, tc.want, prs[0].Empty)
		})
	}
}

func TestHasWebhook_MatchesByURLPath(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{
			{"id": 1, "type": "discord", "config": map[string]string{"url": "https://example.com/discord"}, "active": true},
			{"id": 2, "type": "forgejo", "config": map[string]string{"url": "https://dashboard.example/api/webhooks/forgejo/tok123"}, "active": true},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	client.SetWebhookPath("/api/webhooks/forgejo/tok123")

	has, err := client.HasWebhook(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	assert.True(t, has)
}

func TestHasWebhook_NoMatchingHook(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{
			{"id": 1, "type": "discord", "config": map[string]string{"url": "https://example.com/discord"}, "active": true},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	client.SetWebhookPath("/api/webhooks/forgejo/tok123")

	has, err := client.HasWebhook(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	assert.False(t, has)
}

func TestHasWebhook_NoWebhookPathConfiguredSkipsTheAPICallEntirely(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/hooks", func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatal("HasWebhook should not call the forge at all with no webhook path configured")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	has, err := client.HasWebhook(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	assert.False(t, has)
}

func TestHasWebhook_ForgeErrorPropagates(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/hooks", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	client.SetWebhookPath("/api/webhooks/forgejo/tok123")

	_, err := client.HasWebhook(t.Context(), "alrayyes", "a")

	require.Error(t, err)
}

func TestEnsureWebhook_CreatesWhenMissing(t *testing.T) {
	t.Parallel()

	var createBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			if r.URL.Query().Get("page") != "1" {
				writeJSON(t, w, []map[string]any{})

				return
			}
			writeJSON(t, w, []map[string]any{
				{"id": 1, "type": "discord", "config": map[string]string{"url": "https://elsewhere.example/hook"}, "active": true},
			})
		case http.MethodPost:
			assert.NoError(t, json.NewDecoder(r.Body).Decode(&createBody))
			writeJSON(t, w, map[string]any{"id": 2})
		default:
			t.Fatalf("unexpected method %s", r.Method)
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	client.SetWebhookPath("/api/webhooks/forgejo/tok123")

	err := client.EnsureWebhook(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/forgejo/tok123", "sekret")

	require.NoError(t, err)
	require.NotNil(t, createBody)
	config, ok := createBody["config"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "https://dashboard.example/api/webhooks/forgejo/tok123", config["url"])
	assert.Equal(t, "sekret", config["secret"])
	assert.Equal(t, true, createBody["active"])
	assert.ElementsMatch(t, []any{"pull_request", "issues", "push", "status"}, createBody["events"])
}

func TestEnsureWebhook_EditsExistingHookInPlace(t *testing.T) {
	t.Parallel()

	var editBody map[string]any
	var editedID string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{
			{"id": 7, "type": "forgejo", "config": map[string]string{"url": "https://dashboard.example/api/webhooks/forgejo/tok123"}, "active": false},
		})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/hooks/7", func(w http.ResponseWriter, r *http.Request) {
		editedID = "7"
		assert.Equal(t, http.MethodPatch, r.Method)
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&editBody))
		w.WriteHeader(http.StatusOK)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	client.SetWebhookPath("/api/webhooks/forgejo/tok123")

	err := client.EnsureWebhook(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/forgejo/tok123", "sekret")

	require.NoError(t, err)
	assert.Equal(t, "7", editedID)
	assert.Equal(t, true, editBody["active"])
}

func TestEnsureWebhook_ForgeErrorPropagates(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusForbidden)

			return
		}
		t.Fatalf("unexpected method %s", r.Method)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	client.SetWebhookPath("/api/webhooks/forgejo/tok123")

	err := client.EnsureWebhook(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/forgejo/tok123", "sekret")

	require.Error(t, err)
}

func TestMergePullRequest_UsesTheRepoSOwnDefaultMergeStyle(t *testing.T) {
	t.Parallel()

	var mergeBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodGet, r.Method)
		writeJSON(t, w, map[string]any{"default_merge_style": "rebase"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5/merge", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&mergeBody))
		w.WriteHeader(http.StatusOK)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	err := client.MergePullRequest(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.NotNil(t, mergeBody)
	assert.Equal(t, "rebase", mergeBody["Do"])
}

func TestMergePullRequest_FallsBackToMergeStyleWhenTheRepoReportsNone(t *testing.T) {
	t.Parallel()

	var mergeBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"default_merge_style": ""})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5/merge", func(w http.ResponseWriter, r *http.Request) {
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&mergeBody))
		w.WriteHeader(http.StatusOK)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	err := client.MergePullRequest(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, "merge", mergeBody["Do"])
}

func TestMergePullRequest_NotMergeable_ClassifiesAsForgeErrorConflict(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"default_merge_style": "merge"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5/merge", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	err := client.MergePullRequest(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
}

// TestMergePullRequest_NotMergeable_SurfacesForgesOwnMessage is a
// regression test: the gitea SDK's own MergePullRequest is built on
// getStatusCode, which closes the response body without ever reading it
// — Forgejo's real reason for rejecting a merge (here, the "empty
// commit" case confirmed live against a real Forgejo instance, a PR
// whose branch content already matched its target) never reached the
// caller, surfacing to the dashboard as a bare "merge rejected (status
// N)" with no way to tell a user why. This client now reads the body
// itself.
func TestMergePullRequest_NotMergeable_SurfacesForgesOwnMessage(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"default_merge_style": "squash"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5/merge", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusMethodNotAllowed)
		assert.NoError(t, json.NewEncoder(w).Encode(map[string]string{
			"message": "the changes on this branch are already on the target branch. this will be an empty commit.",
		}))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	err := client.MergePullRequest(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "the changes on this branch are already on the target branch")
}

func TestMergePullRequest_RepoLookupFails_PropagatesTheError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	err := client.MergePullRequest(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}

func TestClosePullRequest_ClosesViaEditEndpoint(t *testing.T) {
	t.Parallel()

	var editBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPatch, r.Method)
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&editBody))
		writeJSON(t, w, map[string]any{"number": 5, "state": "closed"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	err := client.ClosePullRequest(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.NotNil(t, editBody)
	assert.Equal(t, "closed", editBody["state"])
}

func TestClosePullRequest_ForgeRejects_ClassifiesTheError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	err := client.ClosePullRequest(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}

func TestUpdateBranch_CallsTheUpdateEndpoint(t *testing.T) {
	t.Parallel()

	var updatedPath string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5/update", func(w http.ResponseWriter, r *http.Request) {
		updatedPath = r.URL.Path
		assert.Equal(t, http.MethodPost, r.Method)
		w.WriteHeader(http.StatusOK)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	accepted, err := client.UpdateBranch(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.False(t, accepted, "Forgejo's update is synchronous, never scheduled")
	assert.Equal(t, "/api/v1/repos/alrayyes/a/pulls/5/update", updatedPath)
}

// retryOnTransientUnreachable retries fn while it classifies as
// dashboard.ForgeErrorUnreachable — a failed dial to this test's own
// httptest server, not a real forge response. Confirmed live in
// alrayyes/forge-dashboard#481: CI's `-race`-instrumented run starts
// every package's t.Parallel() tests at once, each opening its own
// httptest.NewServer, and on a resource-constrained runner an outbound
// connection to a same-process loopback listener occasionally loses that
// race — well outside what this classification is meant to catch. Not
// reproducible locally under matched load (-race, GOMAXPROCS=2, this
// package's exact CI invocation, repeated dozens of times) on a
// dev machine with far more headroom than the runner; see the issue for
// the full investigation. A real classification bug still fails here,
// since retrying only masks the one error kind that (by construction)
// this test's own mock server can never actually return.
func retryOnTransientUnreachable(t *testing.T, fn func() (bool, error)) (bool, error) {
	t.Helper()

	var accepted bool
	var err error
	for range 3 {
		accepted, err = fn()
		var clientErr *dashboard.ClientError
		if !errors.As(err, &clientErr) || clientErr.Kind != dashboard.ForgeErrorUnreachable {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	return accepted, err
}

func TestUpdateBranch_CannotMergeCleanly_ClassifiesAsForgeErrorConflict(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5/update", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	_, err := retryOnTransientUnreachable(t, func() (bool, error) {
		return client.UpdateBranch(t.Context(), "alrayyes", "a", 5)
	})

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
}

// TestUpdateBranch_CannotMergeCleanly_SurfacesForgesOwnMessage matches
// TestMergePullRequest_NotMergeable_SurfacesForgesOwnMessage: the gitea
// SDK's UpdatePullRequest is also built on getStatusCode, so it has the
// exact same body-discarding gap.
func TestUpdateBranch_CannotMergeCleanly_SurfacesForgesOwnMessage(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5/update", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		assert.NoError(t, json.NewEncoder(w).Encode(map[string]string{
			"message": "merge conflict, unable to update",
		}))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	_, err := client.UpdateBranch(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "merge conflict, unable to update")
}

func TestListChecks_ReturnsEveryJobAcrossEveryRunForTheHeadSHA(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "cafef00d", r.URL.Query().Get("head_sha"))
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 2, "jobs": []map[string]any{
			{"name": "build", "status": "success", "html_url": "https://git.example/alrayyes/a/actions/runs/42/jobs/1"},
			{"name": "test", "status": "running", "html_url": "https://git.example/alrayyes/a/actions/runs/42/jobs/2"},
		}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 2)
	assert.Equal(t, dashboard.Check{Name: "build", State: dashboard.CheckSuccess, URL: "https://git.example/alrayyes/a/actions/runs/42/jobs/1"}, checks[0])
	assert.Equal(t, dashboard.Check{Name: "test", State: dashboard.CheckRunning, URL: "https://git.example/alrayyes/a/actions/runs/42/jobs/2"}, checks[1])
}

// TestListChecks_JobsEndpointReturnsBareArray_StillParses guards against
// the response-shape mismatch confirmed live in the sibling project
// alrayyes/pipeline-analytics#123: a real, newer Forgejo instance can
// answer /actions/runs/{id}/jobs with a bare JSON array instead of the
// {"total_count":N,"jobs":[...]} wrapper the gitea SDK's own typed
// ListRepoActionRunJobs expects, and with this client's version gates
// disabled (see NewClient's own SetGiteaVersion("") comment) the SDK has
// no way to protect itself from it.
func TestListChecks_JobsEndpointReturnsBareArray_StillParses(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{
			{"name": "build", "status": "failure", "html_url": "https://git.example/alrayyes/a/actions/runs/42/jobs/1"},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.Equal(t, dashboard.Check{Name: "build", State: dashboard.CheckFailure, URL: "https://git.example/alrayyes/a/actions/runs/42/jobs/1"}, checks[0])
}

func TestListChecks_ActionsRoutesNotFound_FallsBackToCombinedStatus(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(t, w, map[string]string{"message": "Not Found"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"statuses": []map[string]any{
			{"context": "ci/legacy", "status": "success", "target_url": "https://ci.example/build/1"},
		}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.Equal(t, dashboard.Check{Name: "ci/legacy", State: dashboard.CheckSuccess, URL: "https://ci.example/build/1"}, checks[0])
}

func TestListChecks_NoRunsForHeadSHA_FallsBackToCombinedStatus(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 0, "workflow_runs": []map[string]any{}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"statuses": []map[string]any{}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Empty(t, checks)
}

func TestListChecks_ActionsRunsForbidden_ReturnsErrorRatherThanFallingBack(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]string{"message": "token does not have at least one of required scope(s)"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	_, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorUnauthorized, clientErr.Kind)
}

func TestListChecks_PullRequestLookupFails_ReturnsError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(t, w, map[string]string{"message": "Not Found"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	_, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}

// reviewPRServer serves one open PR per entry in prs (number, draft,
// updated_at, requested reviewer logins) and counts calls to each PR's
// reviews endpoint. reviews maps a PR number to its review list; a number
// absent from it gets a 500.
func reviewPRServer(t *testing.T, prs []map[string]any, reviews map[int][]map[string]any, calls *atomic.Int32) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, prs)
	})
	for n, rs := range reviews {
		mux.HandleFunc(fmt.Sprintf("/api/v1/repos/alrayyes/a/pulls/%d/reviews", n), func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			if r.URL.Query().Get("page") != "" && r.URL.Query().Get("page") != "1" {
				writeJSON(t, w, []map[string]any{})

				return
			}
			writeJSON(t, w, rs)
		})
	}

	return httptest.NewServer(mux)
}

func reviewPR(number int, draft bool, updated string, requested ...string) map[string]any {
	users := make([]map[string]string, 0, len(requested))
	for _, l := range requested {
		users = append(users, map[string]string{"login": l})
	}

	return map[string]any{
		"number": number, "title": "t", "html_url": "https://x", "draft": draft,
		"user": map[string]string{"login": "u"}, "updated_at": updated,
		"requested_reviewers": users,
	}
}

func review(login, state string, dismissed bool, submitted string) map[string]any {
	return map[string]any{
		"user": map[string]string{"login": login}, "state": state,
		"dismissed": dismissed, "submitted_at": submitted,
	}
}

func TestListOpenPullRequests_MapsReviewState(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := reviewPRServer(t,
		[]map[string]any{
			reviewPR(1, false, "2026-09-02T00:00:00Z", "bob"),
			reviewPR(2, false, "2026-09-02T00:00:00Z"),
			reviewPR(3, false, "2026-09-02T00:00:00Z"),
			reviewPR(4, true, "2026-09-02T00:00:00Z", "bob"),
			reviewPR(5, false, "2026-09-02T00:00:00Z"),
		},
		map[int][]map[string]any{
			1: {},
			// Only each reviewer's latest, non-dismissed, opinionated review counts.
			2: {
				review("bob", "REQUEST_CHANGES", false, "2026-09-01T00:00:00Z"),
				review("bob", "APPROVED", false, "2026-09-01T12:00:00Z"),
				review("amy", "COMMENT", false, "2026-09-01T13:00:00Z"),
				review("cat", "APPROVED", true, "2026-09-01T14:00:00Z"),
			},
			3: {review("bob", "REQUEST_CHANGES", false, "2026-09-01T00:00:00Z"), review("amy", "APPROVED", false, "2026-09-01T00:00:00Z")},
			4: {},
		},
		&calls)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	prs, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	require.Len(t, prs, 5)

	assert.Equal(t, &dashboard.ReviewState{Decision: dashboard.ReviewRequired, RequestedReviewers: 1}, prs[0].Review)
	assert.Equal(t, &dashboard.ReviewState{Decision: dashboard.ReviewApproved, Approvals: 1}, prs[1].Review)
	assert.Equal(t, &dashboard.ReviewState{Decision: dashboard.ReviewChangesRequested, Approvals: 1}, prs[2].Review)
	// Drafts cost no reviews call and stay unknown.
	assert.Nil(t, prs[3].Review)
	// A failed reviews call (no handler, so 404) is unknown, never "none".
	assert.Nil(t, prs[4].Review)
	assert.Equal(t, int32(3), calls.Load())
}

func TestListOpenPullRequests_CachesReviewsUntilUpdatedAtChanges(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	updated := "2026-09-02T00:00:00Z"
	var mu sync.Mutex
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		mu.Lock()
		defer mu.Unlock()
		writeJSON(t, w, []map[string]any{reviewPR(1, false, updated)})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/1/reviews", func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	list := func() {
		_, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
		require.NoError(t, err)
	}

	list()
	list()
	assert.Equal(t, int32(1), calls.Load(), "an unchanged PR must be served from the cache")

	mu.Lock()
	updated = "2026-09-03T00:00:00Z"
	mu.Unlock()
	list()
	assert.Equal(t, int32(2), calls.Load(), "a newer updated_at must refetch")
}

func forgejoChecksServer(t *testing.T, protections any, protStatus int) *forgejo.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"ref": "main"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"statuses": []map[string]any{
			{"context": "ci/build", "status": "success"},
			{"context": "ci/lint", "status": "failure"},
			{"context": "codecov/patch", "status": "success"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/branch_protections", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(protStatus)
		writeJSON(t, w, protections)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func requiredOf(checks []dashboard.Check) map[string]string {
	out := map[string]string{}
	for _, c := range checks {
		switch {
		case c.Required == nil:
			out[c.Name] = "unknown"
		case *c.Required:
			out[c.Name] = "required"
		default:
			out[c.Name] = "advisory"
		}
	}

	return out
}

func TestListChecks_StatusCheckContextsPatterns_SplitRequiredFromAdvisory(t *testing.T) {
	t.Parallel()

	client := forgejoChecksServer(t, []map[string]any{
		{"rule_name": "release/**", "enable_status_check": true, "status_check_contexts": []string{"other"}},
		{"rule_name": "main", "enable_status_check": true, "status_check_contexts": []string{"ci/build", "ci/li*"}},
	}, http.StatusOK)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, map[string]string{"ci/build": "required", "ci/lint": "required", "codecov/patch": "advisory"}, requiredOf(checks))
}

func TestListChecks_BranchWithoutProtectionOrStatusCheck_EverythingIsAdvisory(t *testing.T) {
	t.Parallel()

	client := forgejoChecksServer(t, []map[string]any{
		{"rule_name": "main", "enable_status_check": false, "status_check_contexts": []string{"ci/build"}},
	}, http.StatusOK)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, map[string]string{"ci/build": "advisory", "ci/lint": "advisory", "codecov/patch": "advisory"}, requiredOf(checks))
}

func TestListChecks_ProtectionsForbidden_RequiredStaysUnknown(t *testing.T) {
	t.Parallel()

	client := forgejoChecksServer(t, map[string]string{"message": "forbidden"}, http.StatusForbidden)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, map[string]string{"ci/build": "unknown", "ci/lint": "unknown", "codecov/patch": "unknown"}, requiredOf(checks))
}

func TestListChecks_ActionsJobMatchingAPattern_IsRequiredButNonMatchStaysUnknown(t *testing.T) {
	t.Parallel()

	// An Actions job's commit-status context is "<workflow> / <job>
	// (<event>)", which the jobs API doesn't give us, so a job that
	// matches no pattern could still be required under that longer name.
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"ref": "main"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42, "path": ".forgejo/workflows/ci.yml", "event": "push"}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"jobs": []map[string]any{
			{"name": "build", "status": "success"},
			{"name": "docs", "status": "success"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/branch_protections", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{{"rule_name": "main", "enable_status_check": true, "status_check_contexts": []string{"*/ build (*)"}}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, map[string]string{"build": "required", "docs": "unknown"}, requiredOf(checks))
}

// Gitea/Forgejo's "Get a pull request" answers state, merged and
// mergeable. It has no mergeable_state equivalent, so only merged, closed
// and a not-mergeable verdict can be told apart. Not verified against a
// live instance: shapes follow the swagger the SDK is generated from.
func TestReadPullRequestState_MapsGetPullRequestFields(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		body map[string]any
		want dashboard.PullRequestState
	}{
		{"already merged", map[string]any{"state": "closed", "merged": true, "mergeable": false, "merged_at": "2026-10-01T10:00:00Z"}, dashboard.PullRequestState{Merged: true, Closed: true}},
		{"closed unmerged", map[string]any{"state": "closed", "merged": false, "mergeable": true}, dashboard.PullRequestState{Closed: true}},
		{"open and not mergeable", map[string]any{"state": "open", "merged": false, "mergeable": false}, dashboard.PullRequestState{Blocked: true}},
		{"open and mergeable", map[string]any{"state": "open", "merged": false, "mergeable": true}, dashboard.PullRequestState{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
				tc.body["number"] = 5
				writeJSON(t, w, tc.body)
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			got, err := forgejo.NewClient(srv.URL, "test-token", "").ReadPullRequestState(t.Context(), "alrayyes", "a", 5)

			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestReadPullRequestState_ForgeFails_ReturnsClassifiedError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := forgejo.NewClient(srv.URL, "test-token", "").ReadPullRequestState(t.Context(), "alrayyes", "a", 5)

	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}

// Reported live on Forgejo (mobile): Merge on an already-merged PR answers
// 405 with {"message":"","url":".../api/swagger"}, an empty reason. The
// refusal text can't explain it, so the error must stay readable (never
// raw JSON) and stay classified as a conflict, leaving the re-read of the
// PR (merged=true) to say already_merged.
func TestMergePullRequest_AlreadyMergedWithEmptyMessage_NeverSurfacesRawJSON(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"default_merge_style": "merge"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5/merge", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusMethodNotAllowed)
		writeJSON(t, w, map[string]any{"message": "", "url": "https://forge.example/api/swagger"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	err := forgejo.NewClient(srv.URL, "test-token", "").MergePullRequest(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
	assert.NotContains(t, err.Error(), "{")
	assert.NotContains(t, err.Error(), "swagger")
}

func TestClosePullRequest_AlreadyMerged_KeepsForgesOwnMessage(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		writeJSON(t, w, map[string]any{"message": "cannot change state of this pull request, it was already merged", "url": "https://forge.example/api/swagger"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	err := forgejo.NewClient(srv.URL, "test-token", "").ClosePullRequest(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "it was already merged")
}

// Forgejo's update endpoint answers a conflict with 409 and says so in the
// message; a merged or closed PR is a 422. Both must keep their text, and
// the conflict must stay a conflict for Update branch to classify.
func TestUpdateBranch_Refusals_KeepForgesOwnMessage(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		status  int
		message string
		kind    dashboard.ForgeErrorKind
	}{
		{"conflict", http.StatusConflict, "merge failed because of conflict", dashboard.ForgeErrorConflict},
		{"permission", http.StatusForbidden, "User not allowed to update this pull request", dashboard.ForgeErrorUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5/update", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				writeJSON(t, w, map[string]any{"message": tc.message, "url": "https://forge.example/api/swagger"})
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			_, err := forgejo.NewClient(srv.URL, "test-token", "").UpdateBranch(t.Context(), "alrayyes", "a", 5)

			require.Error(t, err)
			var clientErr *dashboard.ClientError
			require.ErrorAs(t, err, &clientErr)
			assert.Equal(t, tc.kind, clientErr.Kind)
			assert.Contains(t, err.Error(), tc.message)
		})
	}
}
