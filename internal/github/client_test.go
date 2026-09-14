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

// graphqlRequestBody is what the client actually posted — tests read it
// back to assert on the query/variables the client sent, or just to
// dispatch per-page fixtures during pagination.
type graphqlRequestBody struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables"`
}

func readGraphQLRequest(t *testing.T, r *http.Request) graphqlRequestBody {
	t.Helper()
	var body graphqlRequestBody
	assert.NoError(t, json.NewDecoder(r.Body).Decode(&body))
	return body
}

func TestFetch_TokenConfigured_UsesGraphQL(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false, "endCursor": ""},
						"nodes": []map[string]any{
							{
								"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
								"owner":        map[string]any{"login": "alrayyes"},
								"pullRequests": map[string]any{"nodes": []map[string]any{}},
								"issues":       map[string]any{"nodes": []map[string]any{}},
							},
						},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	assert.Equal(t, 1, result.Health.RepoCount)
}

func TestFetch_ReportsRateLimit(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 4922, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.NotNil(t, result.Health.RateLimit)
	assert.Equal(t, 5000, result.Health.RateLimit.Limit)
	assert.Equal(t, 4922, result.Health.RateLimit.Remaining)
}

func TestFetch_ExcludesArchivedForkedAndReadOnlyRepos(t *testing.T) {
	t.Parallel()

	repoNode := func(name string, archived, fork bool, permission string) map[string]any {
		return map[string]any{
			"name": name, "isArchived": archived, "isFork": fork, "viewerPermission": permission,
			"owner":        map[string]any{"login": "alrayyes"},
			"pullRequests": map[string]any{"nodes": []map[string]any{}},
			"issues":       map[string]any{"nodes": []map[string]any{}},
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes": []map[string]any{
							repoNode("active", false, false, "WRITE"),
							repoNode("archived", true, false, "WRITE"),
							repoNode("forked", false, true, "WRITE"),
							repoNode("read-only", false, false, "READ"),
							repoNode("admin", false, false, "ADMIN"),
						},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	assert.Equal(t, 2, result.Health.RepoCount, "only \"active\" (WRITE) and \"admin\" (ADMIN) should count")
}

func TestFetch_MapsPullRequestFieldsAndCIFromStatusCheckRollup(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes": []map[string]any{
							{
								"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
								"owner": map[string]any{"login": "alrayyes"},
								"pullRequests": map[string]any{
									"nodes": []map[string]any{
										{
											"number": 12, "title": "Add NTP alarm", "url": "https://github.com/alrayyes/a/pull/12",
											"isDraft": false, "author": map[string]any{"login": "ryankes"},
											"labels":    map[string]any{"nodes": []map[string]any{{"name": "topic/monitoring", "color": "1d76db"}}},
											"createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
											"commits": map[string]any{
												"nodes": []map[string]any{
													{"commit": map[string]any{"statusCheckRollup": map[string]any{"state": "SUCCESS"}}},
												},
											},
										},
									},
								},
								"issues": map[string]any{"nodes": []map[string]any{}},
							},
						},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	pr := result.PullRequests[0]

	t.Run("basic fields", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, 12, pr.Number)
		assert.Equal(t, "Add NTP alarm", pr.Title)
		assert.Equal(t, "ryankes", pr.Author)
		assert.Equal(t, "alrayyes/a", pr.Repo)
	})
	t.Run("labels carry through", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, []dashboard.Label{{Name: "topic/monitoring", Color: "1d76db"}}, pr.Labels)
	})
	t.Run("CI reflects the status check rollup", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, dashboard.CISuccess, pr.CI)
	})
}

func TestFetch_PullRequestWithNoStatusCheckRollup_ReportsCINone(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes": []map[string]any{
							{
								"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
								"owner": map[string]any{"login": "alrayyes"},
								"pullRequests": map[string]any{
									"nodes": []map[string]any{
										{
											"number": 1, "title": "x", "url": "https://x", "isDraft": false,
											"author": map[string]any{"login": "u"}, "labels": map[string]any{"nodes": []map[string]any{}},
											"createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-01T00:00:00Z",
											"commits": map[string]any{
												"nodes": []map[string]any{
													{"commit": map[string]any{"statusCheckRollup": nil}},
												},
											},
										},
									},
								},
								"issues": map[string]any{"nodes": []map[string]any{}},
							},
						},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CINone, result.PullRequests[0].CI)
}

func TestFetch_NullAuthor_ReportsGhost(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes": []map[string]any{
							{
								"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
								"owner":        map[string]any{"login": "alrayyes"},
								"pullRequests": map[string]any{"nodes": []map[string]any{}},
								"issues": map[string]any{
									"nodes": []map[string]any{
										{
											"number": 5, "title": "deleted account's issue", "url": "https://x",
											"author": nil, "labels": map[string]any{"nodes": []map[string]any{}},
											"createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-01T00:00:00Z",
										},
									},
								},
							},
						},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.Len(t, result.Issues, 1)
	assert.Equal(t, "ghost", result.Issues[0].Author)
}

func TestFetch_FollowsPagination(t *testing.T) {
	t.Parallel()

	repoNode := func(name string) map[string]any {
		return map[string]any{
			"name": name, "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
			"owner":        map[string]any{"login": "alrayyes"},
			"pullRequests": map[string]any{"nodes": []map[string]any{}},
			"issues":       map[string]any{"nodes": []map[string]any{}},
		}
	}

	calls := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		calls++
		if body.Variables["cursor"] == nil {
			writeJSON(t, w, map[string]any{
				"data": map[string]any{
					"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
					"viewer": map[string]any{
						"repositories": map[string]any{
							"pageInfo": map[string]any{"hasNextPage": true, "endCursor": "cursor-1"},
							"nodes":    []map[string]any{repoNode("a")},
						},
					},
				},
			})
			return
		}
		assert.Equal(t, "cursor-1", body.Variables["cursor"])
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{repoNode("b")},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	assert.Equal(t, 2, result.Health.RepoCount)
	assert.Equal(t, 2, calls)
}

func TestFetch_GraphQLErrorsArray_ReportsUnreachable(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"errors": []map[string]any{{"message": "Could not resolve to a User with the login of 'ghost'."}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Contains(t, result.Health.Error, "Could not resolve to a User")
}

func TestFetch_ErrorIncludesAPIMessage(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]string{"message": "API rate limit exceeded for user ID 511318."})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Contains(t, result.Health.Error, "API rate limit exceeded for user ID 511318.")
}

func TestFetch_RateLimitExceeded_ShortMessage_NotGitHubsBoilerplate(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "1789400145")
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]string{
			"message": "API rate limit exceeded for user ID 511318. If you reach out to GitHub Support for help, please include the request ID 96A4:2BFEEC:245A8CA:235532C:6AA812F3 and timestamp 2026-09-14 15:29:55 UTC. For more on scraping GitHub and how it may affect your rights, please review our Terms of Service (https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)",
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Equal(t, "github: POST /graphql: rate limit exceeded", result.Health.Error)
	assert.NotContains(t, result.Health.Error, "Terms of Service")
	assert.NotContains(t, result.Health.Error, "GitHub Support")
}

func TestFetch_RateLimitExceeded_StillPopulatesRateLimit(t *testing.T) {
	t.Parallel()

	// The whole point of #142: this is the one moment a person most needs
	// to see the budget, and the old design never even attempted the
	// check because the request that would have made it also failed.
	// GitHub sends the same X-RateLimit-* headers on the failed response
	// itself.
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "1789400145")
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]string{"message": "API rate limit exceeded."})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	require.NotNil(t, result.Health.RateLimit)
	assert.Equal(t, 5000, result.Health.RateLimit.Limit)
	assert.Equal(t, 0, result.Health.RateLimit.Remaining)
	assert.Equal(t, int64(1789400145), result.Health.RateLimit.ResetsAt.Unix())
}

func TestFetch_FailureWithNoRateLimitHeaders_LeavesRateLimitNil(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		writeJSON(t, w, map[string]string{"message": "Bad credentials"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Contains(t, result.Health.Error, "Bad credentials")
	assert.Nil(t, result.Health.RateLimit, "no rate-limit headers means nothing to report, not a fabricated zero")
}

func TestFetch_RetryAfterIncludedWhenPresent(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "42")
		w.WriteHeader(http.StatusTooManyRequests)
		writeJSON(t, w, map[string]string{"message": "You have exceeded a secondary rate limit."})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Contains(t, result.Health.Error, "retry after 42s")
}

func TestFetch_NoTokenNoUsername_ReportsUnreachable(t *testing.T) {
	t.Parallel()

	client := github.NewClient("", "", "http://unused.invalid")
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.NotEmpty(t, result.Health.Error)
}

// ---- REST fallback: username configured, no token ----

func TestFetch_NoToken_FallsBackToUsernamesPublicRepos(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/users/alrayyes/repos", func(w http.ResponseWriter, r *http.Request) {
		assert.Empty(t, r.Header.Get("Authorization"), "the public fallback should never send a credential")
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/tempus-fugit", "name": "tempus-fugit", "owner": map[string]string{"login": "alrayyes"}},
		})
	})
	mux.HandleFunc("/repos/alrayyes/tempus-fugit/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/tempus-fugit/issues", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("", "alrayyes", srv.URL)
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	assert.Equal(t, 1, result.Health.RepoCount)
	assert.Nil(t, result.Health.RateLimit, "the REST fallback has no rate-limit reporting")
}

func TestFetch_NoToken_ExcludesArchivedAndForkedRepos(t *testing.T) {
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
	mux.HandleFunc("/repos/alrayyes/active/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/active/issues", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("", "alrayyes", srv.URL)
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	assert.Equal(t, 1, result.Health.RepoCount)
}

func TestFetch_NoToken_MapsPullRequestFieldsAndResolvesCIFromCheckRuns(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/users/alrayyes/repos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/a", "name": "a", "owner": map[string]string{"login": "alrayyes"}},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{
				"number": 12, "title": "Add NTP alarm", "html_url": "https://github.com/alrayyes/a/pull/12",
				"draft": false, "user": map[string]string{"login": "ryankes"},
				"labels":     []map[string]string{{"name": "topic/monitoring", "color": "1d76db"}},
				"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
				"head": map[string]string{"sha": "cafef00d"},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/issues", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": []map[string]string{{"status": "completed", "conclusion": "success"}}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("", "alrayyes", srv.URL)
	result := client.Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	pr := result.PullRequests[0]
	assert.Equal(t, 12, pr.Number)
	assert.Equal(t, "ryankes", pr.Author)
	assert.Equal(t, dashboard.CISuccess, pr.CI)
}

func TestFetch_NoToken_ExcludesPullRequestsFromIssues(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/users/alrayyes/repos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/a", "name": "a", "owner": map[string]string{"login": "alrayyes"}},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/a/issues", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{
				"number": 1, "title": "a real issue", "html_url": "https://x",
				"user": map[string]string{"login": "u"}, "labels": []map[string]string{},
				"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-01T00:00:00Z",
			},
			{
				"number": 2, "title": "actually a PR", "html_url": "https://x",
				"user": map[string]string{"login": "u"}, "labels": []map[string]string{},
				"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-01T00:00:00Z",
				"pull_request": map[string]string{"url": "https://x"},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("", "alrayyes", srv.URL)
	result := client.Fetch(t.Context())

	require.Len(t, result.Issues, 1)
	assert.Equal(t, 1, result.Issues[0].Number)
}

func TestFetch_Source(t *testing.T) {
	t.Parallel()
	var _ dashboard.Source = github.NewClient("token", "", "")
}
