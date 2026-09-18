package github_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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

// TestFetch_QueriesNewestPullRequestsAndIssuesFirst is a regression test
// for a real bug: GitHub's GraphQL schema defaults an issues/pullRequests
// connection's order to CREATED_AT ascending — oldest first — when no
// orderBy is given. itemsPerRepo (50) is a hard page cap with no further
// pagination, so on a repo with 50+ open items, "oldest first" silently
// drops everything newer than the 50th-oldest, including whatever a
// webhook just fired for. Asserting on the query text itself, not a
// fixture server's response ordering: this repo's own fake server just
// returns whatever JSON a test hands it, so it can't reproduce GitHub's
// real default-ordering behavior — the only way to prove the fix is to
// confirm the client actually asks for descending order, trusting
// GitHub's own docs for what happens without it.
func TestFetch_QueriesNewestPullRequestsAndIssuesFirst(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		assert.Equal(t, 2, strings.Count(body.Query, "orderBy: {field: CREATED_AT, direction: DESC}"), "both pullRequests and issues should ask for newest first")
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
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

	require.True(t, result.Health.Reachable)
}

func TestFetchRepo_QueriesNewestPullRequestsAndIssuesFirst(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		assert.Equal(t, 2, strings.Count(body.Query, "orderBy: {field: CREATED_AT, direction: DESC}"), "both pullRequests and issues should ask for newest first")
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"repository": map[string]any{
					"pullRequests": map[string]any{"nodes": []map[string]any{}},
					"issues":       map[string]any{"nodes": []map[string]any{}},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	_, _, err := client.FetchRepo(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
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
	assert.ElementsMatch(t, []dashboard.Repo{
		{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/active", CanManageWebhooks: false},
		{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/admin", CanManageWebhooks: true},
	}, result.Repos, "WRITE tracks the repo but can't manage its webhooks; only ADMIN can")
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

func TestFetch_GraphQLErrorsArray_RateLimitReportedAsHTTP200_StillGetsShortMessageAndRateLimit(t *testing.T) {
	t.Parallel()

	// Confirmed live: GitHub doesn't always reject a rate-limited GraphQL
	// request outright — sometimes it answers 200 with the same "API rate
	// limit exceeded" complaint as a query-level error instead, carrying
	// the same X-RateLimit-* headers regardless.
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "1789400145")
		writeJSON(t, w, map[string]any{
			"errors": []map[string]any{{"message": "API rate limit exceeded for user ID 511318. If you reach out to GitHub Support for help..."}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Equal(t, "github: graphql: rate limit exceeded", result.Health.Error)
	assert.NotContains(t, result.Health.Error, "GitHub Support")
	require.NotNil(t, result.Health.RateLimit)
	assert.Equal(t, 0, result.Health.RateLimit.Remaining)
}

func TestFetch_GraphQL_ClassifiesErrorKindFromStatus(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		statusCode int
		wantKind   dashboard.ForgeErrorKind
	}{
		{"unauthorized", http.StatusUnauthorized, dashboard.ForgeErrorUnauthorized},
		{"forbidden", http.StatusForbidden, dashboard.ForgeErrorUnauthorized},
		{"not found", http.StatusNotFound, dashboard.ForgeErrorNotFound},
		{"server error", http.StatusInternalServerError, dashboard.ForgeErrorUnknown},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.statusCode)
				writeJSON(t, w, map[string]string{"message": "boom"})
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			client := github.NewClient("test-token", "", srv.URL)
			result := client.Fetch(t.Context())

			require.False(t, result.Health.Reachable)
			assert.Equal(t, tt.wantKind, result.Health.ErrorKind)
		})
	}
}

func TestFetch_GraphQL_RateLimitHeadersOverrideStatusClassification(t *testing.T) {
	t.Parallel()

	// A 403 with an exhausted budget is rate limiting, not "unauthorized" —
	// the header check has to win over the plain status-code mapping.
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]string{"message": "API rate limit exceeded."})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Equal(t, dashboard.ForgeErrorRateLimited, result.Health.ErrorKind)
}

func TestFetch_GraphQL_ClassifiesErrorKindFromExtensionsType(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		extensionType string
		wantKind      dashboard.ForgeErrorKind
	}{
		{"forbidden", "FORBIDDEN", dashboard.ForgeErrorUnauthorized},
		{"unauthenticated", "UNAUTHENTICATED", dashboard.ForgeErrorUnauthorized},
		{"insufficient scopes", "INSUFFICIENT_SCOPES", dashboard.ForgeErrorUnauthorized},
		{"not found", "NOT_FOUND", dashboard.ForgeErrorNotFound},
		{"rate limited", "RATE_LIMITED", dashboard.ForgeErrorRateLimited},
		{"unrecognized", "SOMETHING_NEW", dashboard.ForgeErrorUnknown},
		{"absent", "", dashboard.ForgeErrorUnknown},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
				entry := map[string]any{"message": "boom"}
				if tt.extensionType != "" {
					entry["extensions"] = map[string]string{"type": tt.extensionType}
				}
				writeJSON(t, w, map[string]any{"errors": []map[string]any{entry}})
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			client := github.NewClient("test-token", "", srv.URL)
			result := client.Fetch(t.Context())

			require.False(t, result.Health.Reachable)
			assert.Equal(t, tt.wantKind, result.Health.ErrorKind)
		})
	}
}

func TestFetch_GraphQL_TransportFailure_ClassifiesAsUnreachable(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.NewServeMux())
	srv.Close() // nothing is listening on this URL anymore

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Equal(t, dashboard.ForgeErrorUnreachable, result.Health.ErrorKind)
	assert.Contains(t, result.Health.Error, "github: POST /graphql:")
}

func TestFetch_NoToken_ClassifiesErrorKindFromStatus(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		statusCode int
		wantKind   dashboard.ForgeErrorKind
	}{
		{"unauthorized", http.StatusUnauthorized, dashboard.ForgeErrorUnauthorized},
		{"not found", http.StatusNotFound, dashboard.ForgeErrorNotFound},
		{"too many requests", http.StatusTooManyRequests, dashboard.ForgeErrorRateLimited},
		{"server error", http.StatusInternalServerError, dashboard.ForgeErrorUnknown},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/users/alrayyes/repos", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.statusCode)
				writeJSON(t, w, map[string]string{"message": "boom"})
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			client := github.NewClient("", "alrayyes", srv.URL)
			result := client.Fetch(t.Context())

			require.False(t, result.Health.Reachable)
			assert.Equal(t, tt.wantKind, result.Health.ErrorKind)
		})
	}
}

func TestFetch_NoToken_TransportFailure_ClassifiesAsUnreachable(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.NewServeMux())
	srv.Close() // nothing is listening on this URL anymore

	client := github.NewClient("", "alrayyes", srv.URL)
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Equal(t, dashboard.ForgeErrorUnreachable, result.Health.ErrorKind)
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
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/tempus-fugit", "name": "tempus-fugit", "owner": map[string]string{"login": "alrayyes"}},
		})
	})
	mux.HandleFunc("/repos/alrayyes/tempus-fugit/pulls", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/tempus-fugit/issues", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
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
	assert.Equal(t, []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/tempus-fugit"}}, result.Repos)
}

func TestFetch_NoToken_ExcludesArchivedAndForkedRepos(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/users/alrayyes/repos", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
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
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/active/issues", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
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
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/a", "name": "a", "owner": map[string]string{"login": "alrayyes"}},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
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
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
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
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/a", "name": "a", "owner": map[string]string{"login": "alrayyes"}},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/a/issues", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
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

func TestClient_ImplementsRepoRefresher(t *testing.T) {
	t.Parallel()
	var _ dashboard.RepoRefresher = github.NewClient("token", "", "")
}

func TestFetchRepo_QueriesOnlyTheNamedRepo(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		assert.Contains(t, body.Query, "repository(owner: $owner, name: $name)")
		assert.Equal(t, "alrayyes", body.Variables["owner"])
		assert.Equal(t, "a", body.Variables["name"])

		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"repository": map[string]any{
					"pullRequests": map[string]any{
						"nodes": []map[string]any{
							{
								"number": 12, "title": "Add NTP alarm", "url": "https://github.com/alrayyes/a/pull/12",
								"isDraft": false, "author": map[string]string{"login": "ryankes"},
								"labels":    map[string]any{"nodes": []map[string]string{{"name": "topic/monitoring", "color": "1d76db"}}},
								"createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
								"commits": map[string]any{"nodes": []map[string]any{
									{"commit": map[string]any{"statusCheckRollup": map[string]any{"state": "SUCCESS"}}},
								}},
							},
						},
					},
					"issues": map[string]any{
						"nodes": []map[string]any{
							{
								"number": 7, "title": "a real issue", "url": "https://github.com/alrayyes/a/issues/7",
								"author":    map[string]string{"login": "ryankes"},
								"labels":    map[string]any{"nodes": []map[string]string{}},
								"createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-01T00:00:00Z",
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
	prs, issues, err := client.FetchRepo(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, prs, 1)
	assert.Equal(t, 12, prs[0].Number)
	assert.Equal(t, "alrayyes/a", prs[0].Repo)
	assert.Equal(t, dashboard.CISuccess, prs[0].CI)
	require.Len(t, issues, 1)
	assert.Equal(t, 7, issues[0].Number)
	assert.Equal(t, "alrayyes/a", issues[0].Repo)
}

func TestFetchRepo_RepositoryNotFound_ReturnsError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": nil}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	_, _, err := client.FetchRepo(t.Context(), "alrayyes", "gone", "alrayyes/gone")

	require.Error(t, err)
}

func TestFetchRepo_GraphQLError_ReturnsError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"errors": []map[string]string{{"message": "Bad credentials"}}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	_, _, err := client.FetchRepo(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "Bad credentials")
}

func TestFetch_MapsMergeStatusFromMergeStateStatus(t *testing.T) {
	t.Parallel()

	cases := []struct {
		mergeStateStatus string
		want             dashboard.MergeStatus
	}{
		{"CLEAN", dashboard.MergeMergeable},
		{"DIRTY", dashboard.MergeConflicting},
		{"BLOCKED", dashboard.MergeBlocked},
		// BEHIND is deliberately MergeUnknown, not MergeBlocked (#359):
		// Behind already carries this exact fact (see
		// TestFetch_MapsBehindFromMergeStateStatus below), and the
		// Update-branch button it drives is the specific, actionable
		// signal — a generic "Blocked" pill next to it would say the
		// same thing twice, less usefully the second time.
		{"BEHIND", dashboard.MergeUnknown},
		{"UNSTABLE", dashboard.MergeBlocked},
		{"HAS_HOOKS", dashboard.MergeBlocked},
		{"DRAFT", dashboard.MergeUnknown},
		{"UNKNOWN", dashboard.MergeUnknown},
	}

	for _, tc := range cases {
		t.Run(tc.mergeStateStatus, func(t *testing.T) {
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
													"mergeStateStatus": tc.mergeStateStatus,
													"autoMergeRequest": nil,
													"labels":           map[string]any{"nodes": []map[string]any{}},
													"createdAt":        "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
													"commits": map[string]any{"nodes": []map[string]any{}},
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
			assert.Equal(t, tc.want, result.PullRequests[0].MergeStatus)
		})
	}
}

// TestFetch_MapsBehindFromMergeStateStatus proves Behind is derived
// straight from mergeStateStatus, independent of MergeStatus's own coarser
// bucketing — BEHIND is true here even though it maps to MergeUnknown, not
// MergeBlocked (see TestFetch_MapsMergeStatusFromMergeStateStatus), and
// every value that does stay in the MergeBlocked bucket (BLOCKED,
// UNSTABLE, HAS_HOOKS) is false here, since "something's blocking this"
// isn't the same claim as "specifically because the base moved."
func TestFetch_MapsBehindFromMergeStateStatus(t *testing.T) {
	t.Parallel()

	cases := []struct {
		mergeStateStatus string
		want             bool
	}{
		{"CLEAN", false},
		{"BEHIND", true},
		{"BLOCKED", false},
		{"UNSTABLE", false},
		{"HAS_HOOKS", false},
		{"DIRTY", false},
	}

	for _, tc := range cases {
		t.Run(tc.mergeStateStatus, func(t *testing.T) {
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
													"mergeStateStatus": tc.mergeStateStatus,
													"autoMergeRequest": nil,
													"labels":           map[string]any{"nodes": []map[string]any{}},
													"createdAt":        "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
													"commits": map[string]any{"nodes": []map[string]any{}},
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
			assert.Equal(t, tc.want, result.PullRequests[0].Behind)
		})
	}
}

func TestFetch_MapsAutoMergeFromAutoMergeRequest(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name             string
		autoMergeRequest any
		want             bool
	}{
		{"present means enabled", map[string]any{"mergeMethod": "SQUASH"}, true},
		{"absent means not enabled", nil, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
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
													"mergeStateStatus": "CLEAN",
													"autoMergeRequest": tc.autoMergeRequest,
													"labels":           map[string]any{"nodes": []map[string]any{}},
													"createdAt":        "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
													"commits": map[string]any{"nodes": []map[string]any{}},
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
			require.NotNil(t, result.PullRequests[0].AutoMergeEnabled)
			assert.Equal(t, tc.want, *result.PullRequests[0].AutoMergeEnabled)
		})
	}
}

// TestFetch_NoToken_AutoMergeFreeButMergeStatusUnknown documents the
// REST-fallback path's asymmetry: AutoMerge is already on the List
// response go-github decodes, but Mergeable/MergeableState aren't (per
// go-github's own doc comment), and this path deliberately doesn't pay a
// per-PR Get call to resolve them — see design.md's Open Questions in
// openspec/changes/archive/*/show-pr-merge-status.
func TestFetch_NoToken_AutoMergeFreeButMergeStatusUnknown(t *testing.T) {
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
	mux.HandleFunc("/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{
			{
				"number": 12, "title": "Add NTP alarm", "html_url": "https://github.com/alrayyes/a/pull/12",
				"draft": false, "user": map[string]string{"login": "ryankes"},
				"labels":     []map[string]string{},
				"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
				"head":       map[string]string{"sha": "cafef00d"},
				"auto_merge": map[string]string{"merge_method": "squash"},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/issues", func(w http.ResponseWriter, r *http.Request) {
		if page := r.URL.Query().Get("page"); page != "" && page != "1" {
			writeJSON(t, w, []map[string]any{})
			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": []map[string]string{}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "success"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("", "alrayyes", srv.URL)
	result := client.Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	pr := result.PullRequests[0]
	assert.Equal(t, dashboard.MergeUnknown, pr.MergeStatus)
	require.NotNil(t, pr.AutoMergeEnabled)
	assert.True(t, *pr.AutoMergeEnabled)
}

func repoNodeWithOwnerName(owner, name string) map[string]any {
	return map[string]any{
		"name": name, "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
		"owner":        map[string]any{"login": owner},
		"pullRequests": map[string]any{"nodes": []map[string]any{}},
		"issues":       map[string]any{"nodes": []map[string]any{}},
	}
}

func TestFetch_SetWebhookPath_MarksRepoWithMatchingHookAsHasWebhook(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{repoNodeWithOwnerName("alrayyes", "a")},
					},
				},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{
			{"id": 1, "config": map[string]any{"url": "https://elsewhere.example/hook"}},
			{"id": 2, "config": map[string]any{"url": "https://dashboard.example/api/webhooks/github/tok123"}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath("/api/webhooks/github/tok123")
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	require.Len(t, result.Repos, 1)
	assert.True(t, result.Repos[0].HasWebhook)
}

func TestFetch_SetWebhookPath_NoMatchingHook(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{repoNodeWithOwnerName("alrayyes", "a")},
					},
				},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{
			{"id": 1, "config": map[string]any{"url": "https://elsewhere.example/hook"}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath("/api/webhooks/github/tok123")
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	require.Len(t, result.Repos, 1)
	assert.False(t, result.Repos[0].HasWebhook)
}

func TestFetch_NoWebhookPathConfigured_SkipsHookCheckEntirely(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{repoNodeWithOwnerName("alrayyes", "a")},
					},
				},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatal("the hooks endpoint should not be called with no webhook path configured")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	require.Len(t, result.Repos, 1)
	assert.False(t, result.Repos[0].HasWebhook)
}

func TestFetch_HooksAPIFails_DegradesToFalseWithoutFailingFetch(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{repoNodeWithOwnerName("alrayyes", "a")},
					},
				},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath("/api/webhooks/github/tok123")
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	require.Len(t, result.Repos, 1)
	assert.False(t, result.Repos[0].HasWebhook)
}

func TestEnsureWebhook_CreatesWhenMissing(t *testing.T) {
	t.Parallel()

	var createBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(t, w, []map[string]any{
				{"id": 1, "config": map[string]any{"url": "https://elsewhere.example/hook"}},
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

	client := github.NewClient("test-token", "", srv.URL)

	err := client.EnsureWebhook(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/github/tok123", "sekret")

	require.NoError(t, err)
	require.NotNil(t, createBody)
	config, ok := createBody["config"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "https://dashboard.example/api/webhooks/github/tok123", config["url"])
	assert.Equal(t, "sekret", config["secret"])
	assert.Equal(t, "json", config["content_type"])
	assert.Equal(t, true, createBody["active"])
	assert.ElementsMatch(t, []any{"pull_request", "issues", "status", "check_run"}, createBody["events"])
}

func TestEnsureWebhook_EditsExistingHookInPlace(t *testing.T) {
	t.Parallel()

	var editBody map[string]any
	var editedPath string
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodGet, r.Method)
		writeJSON(t, w, []map[string]any{
			{"id": 7, "config": map[string]any{"url": "https://dashboard.example/api/webhooks/github/tok123"}, "active": false},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks/7", func(w http.ResponseWriter, r *http.Request) {
		editedPath = r.URL.Path
		require.Equal(t, http.MethodPatch, r.Method)
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&editBody))
		writeJSON(t, w, map[string]any{"id": 7})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.EnsureWebhook(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/github/tok123", "sekret")

	require.NoError(t, err)
	assert.Equal(t, "/repos/alrayyes/a/hooks/7", editedPath)
	assert.Equal(t, true, editBody["active"])
}

// TestEnsureWebhook_SendsAuthorizationHeader is a regression test for a
// real bug: the REST client used for webhook calls was built from a bare
// http.Client and never had the token applied to it, so every request
// went out with no Authorization header at all. Real GitHub rejects that
// with 401 "Requires authentication" — reproduced here by having the
// fake server do the same, rather than asserting on the header directly,
// so the test fails the same way a live call against github.com would.
func TestEnsureWebhook_SendsAuthorizationHeader(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			writeJSON(t, w, map[string]any{"message": "Requires authentication"})
			return
		}
		switch r.Method {
		case http.MethodGet:
			writeJSON(t, w, []map[string]any{})
		case http.MethodPost:
			writeJSON(t, w, map[string]any{"id": 2})
		default:
			t.Fatalf("unexpected method %s", r.Method)
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.EnsureWebhook(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/github/tok123", "sekret")

	require.NoError(t, err)
}

func TestEnsureWebhook_ForgeErrorPropagates(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		t.Fatalf("unexpected method %s", r.Method)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.EnsureWebhook(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/github/tok123", "sekret")

	require.Error(t, err)
}

// TestEnsureWebhook_RateLimited_ClassifiesAsDashboardClientError is a
// regression test for a real bug: EnsureWebhook returns the package's own
// unexported apiError, which carries a Kind classification internally but
// was never promoted to dashboard.ClientError at this method's own
// boundary — unlike internal/forgejo's client, which always wraps at its
// equivalent boundary (forgejoError). clientErrorStatus (internal/api/
// webhook_ensure.go) classifies purely via errors.As(err,
// &dashboard.ClientError{}), so a real GitHub rate-limit response here fell
// through to the generic 502 default instead of 429 — indistinguishable
// from a genuine outage. This reproduces the real shape GitHub sends for
// core rate limiting: 403 with X-RateLimit-Remaining: 0 (go-github's own
// CheckResponse is what turns that into a *github.RateLimitError).
func TestEnsureWebhook_RateLimited_ClassifiesAsDashboardClientError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodGet, r.Method)
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]any{"message": "API rate limit exceeded"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.EnsureWebhook(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/github/tok123", "sekret")

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorRateLimited, clientErr.Kind)
}

func TestMergePullRequest_RepoAllowsMergeCommit_UsesMerge(t *testing.T) {
	t.Parallel()

	var mergedPath string
	var mergeBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"allow_merge_commit": true,
			"allow_squash_merge": true,
			"allow_rebase_merge": true,
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/pulls/5/merge", func(w http.ResponseWriter, r *http.Request) {
		mergedPath = r.URL.Path
		require.Equal(t, http.MethodPut, r.Method)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&mergeBody))
		writeJSON(t, w, map[string]any{"merged": true, "message": "Pull Request successfully merged"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.MergePullRequest(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, "/repos/alrayyes/a/pulls/5/merge", mergedPath)
	assert.Equal(t, "merge", mergeBody["merge_method"])
}

func TestMergePullRequest_RepoDisallowsMergeCommit_FallsBackToSquash(t *testing.T) {
	t.Parallel()

	var mergeBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"allow_merge_commit": false,
			"allow_squash_merge": true,
			"allow_rebase_merge": false,
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/pulls/5/merge", func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, json.NewDecoder(r.Body).Decode(&mergeBody))
		writeJSON(t, w, map[string]any{"merged": true, "message": "Pull Request successfully merged"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.MergePullRequest(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, "squash", mergeBody["merge_method"])
}

func TestMergePullRequest_RepoAllowsOnlyRebase_UsesRebase(t *testing.T) {
	t.Parallel()

	var mergeBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"allow_merge_commit": false,
			"allow_squash_merge": false,
			"allow_rebase_merge": true,
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/pulls/5/merge", func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, json.NewDecoder(r.Body).Decode(&mergeBody))
		writeJSON(t, w, map[string]any{"merged": true, "message": "Pull Request successfully merged"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.MergePullRequest(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, "rebase", mergeBody["merge_method"])
}

func TestMergePullRequest_RepoLookupFails_ReturnsError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(t, w, map[string]any{"message": "Not Found"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.MergePullRequest(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}

func TestMergePullRequest_NotMergeable_ClassifiesAsForgeErrorConflict(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"allow_merge_commit": true})
	})
	mux.HandleFunc("/repos/alrayyes/a/pulls/5/merge", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusMethodNotAllowed)
		writeJSON(t, w, map[string]any{"message": "Pull Request is not mergeable"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.MergePullRequest(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
}

func TestUpdateBranch_CallsTheUpdateEndpoint(t *testing.T) {
	t.Parallel()

	var updatedPath string
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5/update-branch", func(w http.ResponseWriter, r *http.Request) {
		updatedPath = r.URL.Path
		require.Equal(t, http.MethodPut, r.Method)
		writeJSON(t, w, map[string]any{"message": "Updating pull request branch."})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	accepted, err := client.UpdateBranch(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.False(t, accepted)
	assert.Equal(t, "/repos/alrayyes/a/pulls/5/update-branch", updatedPath)
}

func TestUpdateBranch_ScheduledAsBackgroundJob_ReportsAcceptedNotAnError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5/update-branch", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	accepted, err := client.UpdateBranch(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.True(t, accepted)
}

func TestUpdateBranch_CannotMergeCleanly_ClassifiesAsForgeErrorConflict(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5/update-branch", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		writeJSON(t, w, map[string]any{"message": "Merge conflict"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	_, err := client.UpdateBranch(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
}
