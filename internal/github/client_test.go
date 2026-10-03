package github_test

import (
	"encoding/json"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

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
				"rateLimit": map[string]any{"limit": 5000, "cost": 3, "remaining": 4922, "resetAt": "2026-09-14T16:00:00Z"},
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

	require.NotNil(t, result.Health.RateLimitGraphQL)
	assert.Equal(t, 5000, result.Health.RateLimitGraphQL.Limit)
	assert.Equal(t, 4922, result.Health.RateLimitGraphQL.Remaining)
	assert.Equal(t, 3, result.Health.RateLimitGraphQL.Cost, "the actual point price this call was charged (#440), not just what's left")
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
	require.NotNil(t, result.Health.RateLimitGraphQL)
	assert.Equal(t, 0, result.Health.RateLimitGraphQL.Remaining)
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
		writeJSON(t, w, map[string]string{"message": "Repository access blocked"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Contains(t, result.Health.Error, "Repository access blocked")
}

// TestFetch_RateLimitMessageSanitizedEvenWithoutHeaders is #360's own
// repro: a real incident this session also hit independently showed
// "API rate limit exceeded for user ID 511318." reaching a client
// verbatim, account ID included — a secondary/abuse-limit rejection
// GitHub sent with none of the usual X-RateLimit-* headers, so the
// header-based check in rateLimitShortMessage never got a chance to
// sanitize it. The message's own content is the fallback.
func TestFetch_RateLimitMessageSanitizedEvenWithoutHeaders(t *testing.T) {
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
	assert.Equal(t, dashboard.ForgeErrorRateLimited, result.Health.ErrorKind)
	assert.Equal(t, "github: POST /graphql: rate limit exceeded", result.Health.Error)
	assert.NotContains(t, result.Health.Error, "511318")
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
	require.NotNil(t, result.Health.RateLimitGraphQL)
	assert.Equal(t, 5000, result.Health.RateLimitGraphQL.Limit)
	assert.Equal(t, 0, result.Health.RateLimitGraphQL.Remaining)
	assert.Equal(t, int64(1789400145), result.Health.RateLimitGraphQL.ResetsAt.Unix())
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
	assert.Nil(t, result.Health.RateLimitGraphQL, "no rate-limit headers means nothing to report, not a fabricated zero")
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
	assert.Nil(t, result.Health.RateLimitREST, "this fake server sets no X-RateLimit-* headers, so there's nothing to have recorded")
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
								"mergeStateStatus": "CLEAN",
								"labels":           map[string]any{"nodes": []map[string]string{{"name": "topic/monitoring", "color": "1d76db"}}},
								"createdAt":        "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
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

// TestFetch_MapsEmptyFromDiffstat is a regression test for a real finding
// (the Forgejo-side counterpart already covered in internal/forgejo): a
// pull request can be mergeable while its additions/deletions/changedFiles
// are all 0 — its content already landed on the base branch some other
// route, so merging it would be an empty commit.
func TestFetch_MapsEmptyFromDiffstat(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name                               string
		additions, deletions, changedFiles int
		want                               bool
	}{
		{"all zero: empty", 0, 0, 0, true},
		{"real diff: not empty", 3, 1, 2, false},
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
													"additions":        tc.additions,
													"deletions":        tc.deletions,
													"changedFiles":     tc.changedFiles,
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
			assert.Equal(t, tc.want, result.PullRequests[0].Empty)
		})
	}
}

// pullRequestNode is a single-PR repositories.nodes fixture shared by the
// behind-detection tests below — mergeStateStatus and headRefOid are the
// two fields that actually vary between cases.
func pullRequestNode(mergeStateStatus string) map[string]any {
	return map[string]any{
		"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
		"owner": map[string]any{"login": "alrayyes"},
		"pullRequests": map[string]any{
			"nodes": []map[string]any{
				{
					"number": 12, "title": "Add NTP alarm", "url": "https://github.com/alrayyes/a/pull/12",
					"isDraft": false, "author": map[string]any{"login": "ryankes"},
					"mergeStateStatus": mergeStateStatus,
					"headRefOid":       "deadbeef",
					"autoMergeRequest": nil,
					"labels":           map[string]any{"nodes": []map[string]any{}},
					"createdAt":        "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
					"commits": map[string]any{"nodes": []map[string]any{}},
				},
			},
		},
		"issues": map[string]any{"nodes": []map[string]any{}},
	}
}

func reposQueryFixture(repoNode map[string]any) map[string]any {
	return map[string]any{
		"data": map[string]any{
			"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
			"viewer": map[string]any{
				"repositories": map[string]any{
					"pageInfo": map[string]any{"hasNextPage": false},
					"nodes":    []map[string]any{repoNode},
				},
			},
		},
	}
}

// TestFetch_MergeStateStatusBlockedButActuallyBehind_ReportsBehindTrue is a
// regression test for #495: GitHub's mergeStateStatus collapses to BLOCKED
// (never BEHIND) whenever a PR is behind its base *and* blocked for
// another reason — confirmed live on alrayyes/forge-dashboard#493, which
// showed BLOCKED while genuinely one commit behind main. A PR whose
// mergeStateStatus isn't itself a reliable signal gets one extra,
// batched compare check instead of being silently reported as not behind.
func TestFetch_MergeStateStatusBlockedButActuallyBehind_ReportsBehindTrue(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "compare(") {
			assert.Equal(t, "alrayyes", body.Variables["owner0"])
			assert.Equal(t, "a", body.Variables["name0"])
			assert.InDelta(t, 12, body.Variables["number0"], 0)
			assert.Equal(t, "deadbeef", body.Variables["head0"])
			writeJSON(t, w, map[string]any{
				"data": map[string]any{
					"pr0": map[string]any{
						"pullRequest": map[string]any{
							"baseRef": map[string]any{
								"compare": map[string]any{"behindBy": 1},
							},
						},
					},
				},
			})

			return
		}
		writeJSON(t, w, reposQueryFixture(pullRequestNode("BLOCKED")))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.True(t, result.PullRequests[0].Behind)
}

// TestFetch_MergeStateStatusBlockedAndNotBehind_StaysFalse is the other
// side of the same fix: an ambiguous mergeStateStatus that turns out NOT
// to be behind (behindBy: 0) must not flip Behind to true just because
// the extra check ran.
func TestFetch_MergeStateStatusBlockedAndNotBehind_StaysFalse(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "compare(") {
			writeJSON(t, w, map[string]any{
				"data": map[string]any{
					"pr0": map[string]any{
						"pullRequest": map[string]any{
							"baseRef": map[string]any{
								"compare": map[string]any{"behindBy": 0},
							},
						},
					},
				},
			})

			return
		}
		writeJSON(t, w, reposQueryFixture(pullRequestNode("BLOCKED")))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.False(t, result.PullRequests[0].Behind)
}

// TestFetch_NoAmbiguousMergeStateStatus_IssuesNoCompareQuery guards the
// common-case cost this fix has to stay cheap for: a poll where every PR
// is already CLEAN or BEHIND (a reliable signal on its own) must not pay
// for the extra compare request at all.
func TestFetch_NoAmbiguousMergeStateStatus_IssuesNoCompareQuery(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "compare(") {
			t.Fatal("no ambiguous PR this poll — a compare query should never have been sent")
		}
		writeJSON(t, w, reposQueryFixture(pullRequestNode("CLEAN")))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.False(t, result.PullRequests[0].Behind)
}

// TestFetch_CompareQueryFails_DegradesToMergeStateStatusOnly matches the
// existing degrade-gracefully convention (see
// TestFetch_HooksAPIFails_DegradesToFalseWithoutFailingFetch): a failed
// follow-up check is a worse answer, not a failed poll.
func TestFetch_CompareQueryFails_DegradesToMergeStateStatusOnly(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "compare(") {
			w.WriteHeader(http.StatusInternalServerError)

			return
		}
		writeJSON(t, w, reposQueryFixture(pullRequestNode("BLOCKED")))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.False(t, result.PullRequests[0].Behind)
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

// TestFetch_MapsAutoMergeAllowedFromViewerCanEnableAutoMerge uses the real
// shape of alrayyes/pipeline-analytics#367 (#738): a stacked pull request
// whose base branch has no protection rule, where GitHub reports
// viewerCanEnableAutoMerge false. A response without the field maps to
// nil, so an older or partial response never hides a working action.
func TestFetch_MapsAutoMergeAllowedFromViewerCanEnableAutoMerge(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		fields map[string]any
		want   *bool
	}{
		{"unprotected stacked base is false", map[string]any{"viewerCanEnableAutoMerge": false}, new(false)},
		{"protected base is true", map[string]any{"viewerCanEnableAutoMerge": true}, new(true)},
		{"absent field is unknown", map[string]any{}, nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var query string
			mux := http.NewServeMux()
			mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Query string `json:"query"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				query = body.Query

				pr := map[string]any{
					"number": 367, "title": "feat(runs): handler", "url": "https://github.com/alrayyes/pipeline-analytics/pull/367",
					"isDraft": false, "author": map[string]any{"login": "ryankes"},
					"mergeStateStatus": "CLEAN",
					"autoMergeRequest": nil,
					"labels":           map[string]any{"nodes": []map[string]any{}},
					"createdAt":        "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
					"commits": map[string]any{"nodes": []map[string]any{}},
				}
				maps.Copy(pr, tc.fields)
				writeJSON(t, w, map[string]any{
					"data": map[string]any{
						"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
						"viewer": map[string]any{
							"repositories": map[string]any{
								"pageInfo": map[string]any{"hasNextPage": false},
								"nodes": []map[string]any{
									{
										"name": "pipeline-analytics", "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
										"owner":        map[string]any{"login": "alrayyes"},
										"pullRequests": map[string]any{"nodes": []map[string]any{pr}},
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

			assert.Contains(t, query, "viewerCanEnableAutoMerge")
			require.Len(t, result.PullRequests, 1)
			assert.Equal(t, tc.want, result.PullRequests[0].AutoMergeAllowed)
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

func repoNodeWithOwnerName() map[string]any {
	return map[string]any{
		"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
		"owner":        map[string]any{"login": "alrayyes"},
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
						"nodes":    []map[string]any{repoNodeWithOwnerName()},
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

// TestFetch_CheckWebhooksSuccess_ReportsRESTRateLimit is #361's own core
// property: checkWebhooks is the one REST call fetchViaGraphQL still
// makes per poll, and its own rate-limit budget — a completely separate
// 5000/hour allowance from the GraphQL query's own rateLimit block —
// has to reach ForgeHealth distinctly, not get silently dropped just
// because the overall fetch is GraphQL-driven.
func TestFetch_CheckWebhooksSuccess_ReportsRESTRateLimit(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{repoNodeWithOwnerName()},
					},
				},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "4321")
		w.Header().Set("X-RateLimit-Reset", "1789400145")
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath("/api/webhooks/github/tok123")
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	require.NotNil(t, result.Health.RateLimitGraphQL)
	assert.Equal(t, 4999, result.Health.RateLimitGraphQL.Remaining, "the GraphQL budget the query itself reported")
	require.NotNil(t, result.Health.RateLimitREST)
	assert.Equal(t, 5000, result.Health.RateLimitREST.Limit)
	assert.Equal(t, 4321, result.Health.RateLimitREST.Remaining, "checkWebhooks' own REST budget, distinct from GraphQL's")
	assert.Equal(t, int64(1789400145), result.Health.RateLimitREST.ResetsAt.Unix())
}

// TestFetch_CheckWebhooksRateLimited_StillReportsRESTRateLimit is the
// case that matters most: exactly when the REST budget is what just ran
// out, its own response still carries the headers saying so — this must
// reach RateLimitREST from the failure path too, not only a success.
func TestFetch_CheckWebhooksRateLimited_StillReportsRESTRateLimit(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{repoNodeWithOwnerName()},
					},
				},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "1789400145")
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]string{"message": "API rate limit exceeded."})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath("/api/webhooks/github/tok123")
	result := client.Fetch(t.Context())

	// checkWebhooks logs and skips a per-repo failure rather than
	// failing the whole forge (see its own doc comment) — the fetch as
	// a whole still succeeds, just with HasWebhook left false for the
	// one repo whose check failed.
	require.True(t, result.Health.Reachable)
	require.Len(t, result.Repos, 1)
	assert.False(t, result.Repos[0].HasWebhook)
	require.NotNil(t, result.Health.RateLimitREST)
	assert.Equal(t, 0, result.Health.RateLimitREST.Remaining)
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
						"nodes":    []map[string]any{repoNodeWithOwnerName()},
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
						"nodes":    []map[string]any{repoNodeWithOwnerName()},
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
						"nodes":    []map[string]any{repoNodeWithOwnerName()},
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
		assert.Equal(t, http.MethodGet, r.Method)
		writeJSON(t, w, []map[string]any{
			{"id": 7, "config": map[string]any{"url": "https://dashboard.example/api/webhooks/github/tok123"}, "active": false},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks/7", func(w http.ResponseWriter, r *http.Request) {
		editedPath = r.URL.Path
		assert.Equal(t, http.MethodPatch, r.Method)
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
		assert.Equal(t, http.MethodGet, r.Method)
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
		assert.Equal(t, http.MethodPut, r.Method)
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&mergeBody))
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
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&mergeBody))
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
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&mergeBody))
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

func TestClosePullRequest_ClosesViaEditEndpoint(t *testing.T) {
	t.Parallel()

	var editBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPatch, r.Method)
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&editBody))
		writeJSON(t, w, map[string]any{"number": 5, "state": "closed"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.ClosePullRequest(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.NotNil(t, editBody)
	assert.Equal(t, "closed", editBody["state"])
}

func TestClosePullRequest_ForgeRejects_ClassifiesTheError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(t, w, map[string]any{"message": "Not Found"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

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
	mux.HandleFunc("/repos/alrayyes/a/pulls/5/update-branch", func(w http.ResponseWriter, r *http.Request) {
		updatedPath = r.URL.Path
		assert.Equal(t, http.MethodPut, r.Method)
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

// GitHub's update-branch endpoint answers 422, not 409, when the head
// can't be updated cleanly (#701).
func TestUpdateBranch_UnprocessableEntity_ClassifiesAsForgeErrorConflict(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5/update-branch", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		writeJSON(t, w, map[string]any{"message": "merge conflict between base and head"})
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

func TestListChecks_ReturnsEveryCheckRunForThePullRequestsHeadSHA(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": []map[string]any{
			{"name": "build", "status": "completed", "conclusion": "success", "html_url": "https://github.com/alrayyes/a/runs/1"},
			{"name": "test", "status": "in_progress", "html_url": "https://github.com/alrayyes/a/runs/2"},
		}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 2)
	assert.Equal(t, dashboard.Check{Name: "build", State: dashboard.CheckSuccess, URL: "https://github.com/alrayyes/a/runs/1"}, checks[0])
	assert.Equal(t, dashboard.Check{Name: "test", State: dashboard.CheckRunning, URL: "https://github.com/alrayyes/a/runs/2"}, checks[1])
}

func TestListChecks_MapsEveryStatusAndConclusionToACheckState(t *testing.T) {
	t.Parallel()

	tests := []struct {
		status     string
		conclusion string
		want       dashboard.CheckState
	}{
		{status: "queued", want: dashboard.CheckQueued},
		{status: "in_progress", want: dashboard.CheckRunning},
		{status: "completed", conclusion: "success", want: dashboard.CheckSuccess},
		{status: "completed", conclusion: "neutral", want: dashboard.CheckSuccess},
		{status: "completed", conclusion: "failure", want: dashboard.CheckFailure},
		{status: "completed", conclusion: "action_required", want: dashboard.CheckFailure},
		{status: "completed", conclusion: "cancelled", want: dashboard.CheckCancelled},
		{status: "completed", conclusion: "skipped", want: dashboard.CheckSkipped},
		{status: "completed", conclusion: "timed_out", want: dashboard.CheckTimedOut},
	}

	for _, tt := range tests {
		t.Run(tt.status+"/"+tt.conclusion, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
			})
			mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(t, w, map[string]any{"check_runs": []map[string]any{
					{"name": "job", "status": tt.status, "conclusion": tt.conclusion},
				}})
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			client := github.NewClient("test-token", "", srv.URL)

			checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

			require.NoError(t, err)
			require.Len(t, checks, 1)
			assert.Equal(t, tt.want, checks[0].State)
		})
	}
}

func TestListChecks_NoCheckRuns_FallsBackToCombinedStatus(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": []map[string]any{}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"statuses": []map[string]any{
			{"context": "ci/legacy", "state": "pending", "target_url": "https://ci.example/build/1"},
		}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.Equal(t, dashboard.Check{Name: "ci/legacy", State: dashboard.CheckRunning, URL: "https://ci.example/build/1"}, checks[0])
}

func TestListChecks_NoChecksAtAll_ReturnsEmptySlice(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": []map[string]any{}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"statuses": []map[string]any{}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Empty(t, checks)
}

func TestListChecks_PullRequestLookupFails_ReturnsError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(t, w, map[string]any{"message": "Not Found"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	_, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}

func TestEnableAutoMerge_RepoAllowsMergeCommit_UsesMerge(t *testing.T) {
	t.Parallel()

	var mutationVars map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "enablePullRequestAutoMerge") {
			mutationVars = body.Variables
			writeJSON(t, w, map[string]any{"data": map[string]any{"enablePullRequestAutoMerge": map[string]any{"clientMutationId": nil}}})

			return
		}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"repository": map[string]any{
					"mergeCommitAllowed": true,
					"squashMergeAllowed": true,
					"rebaseMergeAllowed": true,
					"pullRequest":        map[string]any{"id": "PR_kwABC"},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.EnableAutoMerge(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.NotNil(t, mutationVars)
	assert.Equal(t, "PR_kwABC", mutationVars["id"])
	assert.Equal(t, "MERGE", mutationVars["method"])
}

func TestEnableAutoMerge_RepoDisallowsMergeCommit_FallsBackToSquash(t *testing.T) {
	t.Parallel()

	var mutationVars map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "enablePullRequestAutoMerge") {
			mutationVars = body.Variables
			writeJSON(t, w, map[string]any{"data": map[string]any{"enablePullRequestAutoMerge": map[string]any{"clientMutationId": nil}}})

			return
		}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"repository": map[string]any{
					"mergeCommitAllowed": false,
					"squashMergeAllowed": true,
					"rebaseMergeAllowed": false,
					"pullRequest":        map[string]any{"id": "PR_kwABC"},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.EnableAutoMerge(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, "SQUASH", mutationVars["method"])
}

func TestEnableAutoMerge_RepoAllowsOnlyRebase_UsesRebase(t *testing.T) {
	t.Parallel()

	var mutationVars map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "enablePullRequestAutoMerge") {
			mutationVars = body.Variables
			writeJSON(t, w, map[string]any{"data": map[string]any{"enablePullRequestAutoMerge": map[string]any{"clientMutationId": nil}}})

			return
		}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"repository": map[string]any{
					"mergeCommitAllowed": false,
					"squashMergeAllowed": false,
					"rebaseMergeAllowed": true,
					"pullRequest":        map[string]any{"id": "PR_kwABC"},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.EnableAutoMerge(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, "REBASE", mutationVars["method"])
}

func TestEnableAutoMerge_LookupFails_ReturnsError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"errors": []map[string]string{{"message": "Bad credentials"}}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.EnableAutoMerge(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "Bad credentials")
}

// TestEnableAutoMerge_RepoDoesNotAllowAutoMerge_ReturnsError is the case
// AC #3 (#526) exists for: a repo whose own allow_auto_merge setting is
// off rejects the mutation itself with a real GraphQL error, surfaced
// here rather than pre-checked — there's no separate "does this repo
// allow auto-merge" field this client fetches ahead of time.
func TestEnableAutoMerge_RepoDoesNotAllowAutoMerge_ReturnsError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "enablePullRequestAutoMerge") {
			writeJSON(t, w, map[string]any{"errors": []map[string]any{{
				"message":    "Auto merge is not allowed for this repository",
				"extensions": map[string]string{"type": "UNPROCESSABLE"},
			}}})

			return
		}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"repository": map[string]any{
					"mergeCommitAllowed": true,
					"squashMergeAllowed": true,
					"rebaseMergeAllowed": true,
					"pullRequest":        map[string]any{"id": "PR_kwABC"},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)

	err := client.EnableAutoMerge(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "not allowed")
	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
}

func TestFetch_MapsReviewState(t *testing.T) {
	t.Parallel()

	reviews := func(states ...string) map[string]any {
		nodes := make([]map[string]any, 0, len(states))
		for _, s := range states {
			nodes = append(nodes, map[string]any{"state": s})
		}

		return map[string]any{"nodes": nodes}
	}

	cases := []struct {
		name     string
		decision any
		requests int
		latest   map[string]any
		want     dashboard.ReviewState
	}{
		{"review required", "REVIEW_REQUIRED", 2, reviews(), dashboard.ReviewState{Decision: dashboard.ReviewRequired, RequestedReviewers: 2}},
		{"approved counts approvals", "APPROVED", 0, reviews("APPROVED", "APPROVED", "COMMENTED"), dashboard.ReviewState{Decision: dashboard.ReviewApproved, Approvals: 2}},
		{"changes requested", "CHANGES_REQUESTED", 1, reviews("CHANGES_REQUESTED", "APPROVED"), dashboard.ReviewState{Decision: dashboard.ReviewChangesRequested, Approvals: 1, RequestedReviewers: 1}},
		{"null decision, nothing happened", nil, 0, reviews(), dashboard.ReviewState{Decision: dashboard.ReviewNone}},
		{"null decision derives approval", nil, 0, reviews("APPROVED"), dashboard.ReviewState{Decision: dashboard.ReviewApproved, Approvals: 1}},
		{"null decision derives requested", nil, 1, reviews(), dashboard.ReviewState{Decision: dashboard.ReviewRequired, RequestedReviewers: 1}},
		{"null decision derives changes", nil, 0, reviews("CHANGES_REQUESTED"), dashboard.ReviewState{Decision: dashboard.ReviewChangesRequested}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var seenQuery string
			mux := http.NewServeMux()
			mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Query string `json:"query"`
				}
				assert.NoError(t, json.NewDecoder(r.Body).Decode(&body))
				seenQuery = body.Query
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
													"reviewDecision":   tc.decision,
													"reviewRequests":   map[string]any{"totalCount": tc.requests},
													"latestReviews":    tc.latest,
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
			require.NotNil(t, result.PullRequests[0].Review)
			assert.Equal(t, tc.want, *result.PullRequests[0].Review)
			// Same single query, no extra per-PR calls (#683).
			assert.Contains(t, seenQuery, "reviewDecision")
			assert.Contains(t, seenQuery, "reviewRequests")
			assert.Contains(t, seenQuery, "latestReviews")
		})
	}
}

// TestFetch_ReviewFieldsAbsentMeansUnknown covers a response without any
// review fields (an older stub, a partial response): unknown, not "none".
func TestFetch_ReviewFieldsAbsentMeansUnknown(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes": []map[string]any{{
							"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
							"owner": map[string]any{"login": "alrayyes"},
							"pullRequests": map[string]any{"nodes": []map[string]any{{
								"number": 12, "title": "x", "url": "https://x", "isDraft": false,
								"author": map[string]any{"login": "u"}, "mergeStateStatus": "CLEAN",
								"labels":    map[string]any{"nodes": []map[string]any{}},
								"createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
								"commits": map[string]any{"nodes": []map[string]any{}},
							}}},
							"issues": map[string]any{"nodes": []map[string]any{}},
						}},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Nil(t, result.PullRequests[0].Review)
}

// requiredChecksServer serves one PR (base branch main) with three check
// runs, plus whatever protection/rules handlers the caller adds.
func requiredChecksServer(t *testing.T, extra func(mux *http.ServeMux)) *github.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"ref": "main"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": []map[string]any{
			{"name": "build", "status": "completed", "conclusion": "success"},
			{"name": "lint", "status": "completed", "conclusion": "failure"},
			{"name": "codecov", "status": "completed", "conclusion": "success"},
		}})
	})
	extra(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL)
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

func TestListChecks_BranchProtectionRequiredChecks_SplitRequiredFromAdvisory(t *testing.T) {
	t.Parallel()

	client := requiredChecksServer(t, func(mux *http.ServeMux) {
		mux.HandleFunc("/repos/alrayyes/a/branches/main/protection/required_status_checks", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, map[string]any{"strict": true, "contexts": []string{"build"}, "checks": []map[string]any{{"context": "build", "app_id": 15368}}})
		})
		mux.HandleFunc("/repos/alrayyes/a/rules/branches/main", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, []map[string]any{})
		})
	})

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, map[string]string{"build": "required", "lint": "advisory", "codecov": "advisory"}, requiredOf(checks))
}

func TestListChecks_RulesetRequiredStatusChecks_CountAsRequired(t *testing.T) {
	t.Parallel()

	client := requiredChecksServer(t, func(mux *http.ServeMux) {
		mux.HandleFunc("/repos/alrayyes/a/branches/main/protection/required_status_checks", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
			writeJSON(t, w, map[string]string{"message": "Branch not protected"})
		})
		mux.HandleFunc("/repos/alrayyes/a/rules/branches/main", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, []map[string]any{{
				"type":       "required_status_checks",
				"parameters": map[string]any{"strict_required_status_checks_policy": false, "required_status_checks": []map[string]any{{"context": "lint"}}},
			}})
		})
	})

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, map[string]string{"build": "advisory", "lint": "required", "codecov": "advisory"}, requiredOf(checks))
}

func TestListChecks_ProtectionUnreadable_RequiredStaysUnknownUnlessARuleSaysSo(t *testing.T) {
	t.Parallel()

	client := requiredChecksServer(t, func(mux *http.ServeMux) {
		mux.HandleFunc("/repos/alrayyes/a/branches/main/protection/required_status_checks", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			writeJSON(t, w, map[string]string{"message": "Resource not accessible by personal access token"})
		})
		mux.HandleFunc("/repos/alrayyes/a/rules/branches/main", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, []map[string]any{{
				"type":       "required_status_checks",
				"parameters": map[string]any{"required_status_checks": []map[string]any{{"context": "build"}}},
			}})
		})
	})

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	// build is known required from the ruleset; the others could still be
	// required by a protection rule this token can't read, so never guess.
	assert.Equal(t, map[string]string{"build": "required", "lint": "unknown", "codecov": "unknown"}, requiredOf(checks))
}

func TestListChecks_NoProtectionLookupSucceeds_RequiredIsAbsentFromJSON(t *testing.T) {
	t.Parallel()

	client := requiredChecksServer(t, func(*http.ServeMux) {})

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 3)
	body, err := json.Marshal(checks[0])
	require.NoError(t, err)
	assert.NotContains(t, string(body), "required")
}

// Real response shapes from GitHub's "Merge a pull request" docs. The
// merge endpoint answers 405 for a PR that can't be merged, 409 when the
// head moved after the request was built, and 403 for a token that isn't
// allowed to merge. The forge's own text has to survive to the caller,
// because the API layer classifies the refusal from it.
func TestMergePullRequest_RefusalsKeepTheForgesOwnMessage(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		status  int
		message string
		kind    dashboard.ForgeErrorKind
	}{
		{"405 not mergeable", http.StatusMethodNotAllowed, "Pull Request is not mergeable", dashboard.ForgeErrorConflict},
		{"409 head modified", http.StatusConflict, "Head branch was modified. Review and try the merge again.", dashboard.ForgeErrorConflict},
		{"403 no permission", http.StatusForbidden, "Resource not accessible by personal access token", dashboard.ForgeErrorUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(t, w, map[string]any{"allow_merge_commit": true})
			})
			mux.HandleFunc("/repos/alrayyes/a/pulls/5/merge", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				writeJSON(t, w, map[string]any{"message": tc.message, "documentation_url": "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request"})
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			err := github.NewClient("test-token", "", srv.URL).MergePullRequest(t.Context(), "alrayyes", "a", 5)

			require.Error(t, err)
			var clientErr *dashboard.ClientError
			require.ErrorAs(t, err, &clientErr)
			assert.Equal(t, tc.kind, clientErr.Kind)
			assert.Contains(t, err.Error(), tc.message)
		})
	}
}

func TestMergePullRequest_RateLimited_CarriesWhenTheBudgetResets(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"allow_merge_commit": true})
	})
	mux.HandleFunc("/repos/alrayyes/a/pulls/5/merge", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "1893456000")
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]any{"message": "API rate limit exceeded for user ID 1."})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	err := github.NewClient("test-token", "", srv.URL).MergePullRequest(t.Context(), "alrayyes", "a", 5)

	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorRateLimited, clientErr.Kind)
	require.NotNil(t, clientErr.RateLimit)
	assert.Equal(t, int64(1893456000), clientErr.RateLimit.ResetsAt.Unix())
}

// "Get a pull request" fields the re-read uses: merged, state,
// draft and mergeable_state (clean, dirty, behind, blocked, unstable,
// draft, has_hooks, unknown).
func TestReadPullRequestState_MapsGetPullRequestFields(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		body map[string]any
		want dashboard.PullRequestState
	}{
		{"already merged", map[string]any{"state": "closed", "merged": true, "merged_at": "2026-10-01T10:00:00Z", "mergeable_state": "unknown"}, dashboard.PullRequestState{Merged: true, Closed: true}},
		{"closed unmerged", map[string]any{"state": "closed", "merged": false, "mergeable_state": "unknown"}, dashboard.PullRequestState{Closed: true}},
		{"conflicting", map[string]any{"state": "open", "merged": false, "mergeable": false, "mergeable_state": "dirty"}, dashboard.PullRequestState{Conflicting: true}},
		{"behind", map[string]any{"state": "open", "merged": false, "mergeable_state": "behind"}, dashboard.PullRequestState{Behind: true}},
		{"blocked", map[string]any{"state": "open", "merged": false, "mergeable_state": "blocked"}, dashboard.PullRequestState{Blocked: true}},
		{"unstable", map[string]any{"state": "open", "merged": false, "mergeable_state": "unstable"}, dashboard.PullRequestState{ChecksFailing: true}},
		{"draft", map[string]any{"state": "open", "merged": false, "draft": true, "mergeable_state": "draft"}, dashboard.PullRequestState{Draft: true}},
		{"clean", map[string]any{"state": "open", "merged": false, "mergeable": true, "mergeable_state": "clean"}, dashboard.PullRequestState{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, http.MethodGet, r.Method)
				tc.body["number"] = 5
				writeJSON(t, w, tc.body)
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			got, err := github.NewClient("test-token", "", srv.URL).ReadPullRequestState(t.Context(), "alrayyes", "a", 5)

			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestReadPullRequestState_ForgeFails_ReturnsClassifiedError(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(t, w, map[string]any{"message": "Not Found"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := github.NewClient("test-token", "", srv.URL).ReadPullRequestState(t.Context(), "alrayyes", "a", 5)

	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}

// GraphQL refuses auto-merge with a 200 and an errors array, no status of
// its own, so the API layer reads the reason from the message. The texts
// below are the ones the dashboard has seen live (#621, #662) and GitHub's
// own wording for a repo that disallows auto-merge.
func TestEnableAutoMerge_RefusalKeepsGitHubsOwnMessage(t *testing.T) {
	t.Parallel()

	for _, message := range []string{
		"Pull request is in clean status",
		"Pull request is in unstable status",
		"Auto merge is not allowed for this repository",
	} {
		t.Run(message, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
				body := readGraphQLRequest(t, r)
				if strings.Contains(body.Query, "enablePullRequestAutoMerge") {
					writeJSON(t, w, map[string]any{"data": nil, "errors": []map[string]any{{"type": "UNPROCESSABLE", "message": message}}})

					return
				}
				writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{
					"mergeCommitAllowed": true, "pullRequest": map[string]any{"id": "PR_kwABC"},
				}}})
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			err := github.NewClient("test-token", "", srv.URL).EnableAutoMerge(t.Context(), "alrayyes", "a", 5)

			require.Error(t, err)
			assert.Contains(t, dashboard.ForgeMessage(err), message)
		})
	}
}

// A pull request lists who was asked to review it (#695), from the same query
// that counts them, so there is no extra call. A team request has no login
// and is left out.
func TestFetch_MapsTheRequestedReviewerLogins(t *testing.T) {
	t.Parallel()

	node := pullRequestNode("CLEAN")
	pr := node["pullRequests"].(map[string]any)["nodes"].([]map[string]any)[0]
	pr["reviewRequests"] = map[string]any{
		"totalCount": 3,
		"nodes": []map[string]any{
			{"requestedReviewer": map[string]any{"login": "bob"}},
			{"requestedReviewer": map[string]any{}},
			{"requestedReviewer": map[string]any{"login": "amy"}},
		},
	}
	pr["latestReviews"] = map[string]any{"nodes": []map[string]any{}}

	var seenQuery string
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		seenQuery = readGraphQLRequest(t, r).Query
		writeJSON(t, w, reposQueryFixture(node))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, []string{"bob", "amy"}, result.PullRequests[0].RequestedReviewerLogins)
	assert.Contains(t, seenQuery, "requestedReviewer")
}

// A pull request carries its base and head branch names and whether it comes
// from a fork (#860), the raw facts a stack is worked out from.
func TestFetch_MapsTheBranchesAndForkFlag(t *testing.T) {
	t.Parallel()

	node := pullRequestNode("CLEAN")
	pr := node["pullRequests"].(map[string]any)["nodes"].([]map[string]any)[0]
	pr["baseRefName"] = "feat/parent"
	pr["headRefName"] = "feat/child"
	pr["isCrossRepository"] = true
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, reposQueryFixture(node))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	got := result.PullRequests[0]
	assert.Equal(t, "feat/parent", got.BaseBranch)
	assert.Equal(t, "feat/child", got.HeadBranch)
	assert.True(t, got.CrossRepository)
}

// A pull request carries its head commit SHA (#759), so a bot's rebase can be
// seen as the head moving even when the pull request is still behind.
func TestFetch_MapsTheHeadCommitSHA(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, reposQueryFixture(pullRequestNode("CLEAN")))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, "deadbeef", result.PullRequests[0].HeadSHA)
}

// hooksServer plays GitHub for three repos (a, b, c) whose hook lists answer
// with the status and message given per repo, counting each call. Used by the
// webhook-check denial tests (#894).
type hooksServer struct {
	mu    sync.Mutex
	calls map[string]int
}

func (h *hooksServer) start(t *testing.T, answers map[string][2]string) *httptest.Server {
	t.Helper()

	h.calls = map[string]int{}
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		nodes := []map[string]any{}
		for _, name := range []string{"a", "b", "c"} {
			node := repoNodeWithOwnerName()
			node["name"] = name
			nodes = append(nodes, node)
		}
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": map[string]any{"limit": 5000, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
			"viewer": map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false}, "nodes": nodes,
			}},
		}})
	})
	for _, name := range []string{"a", "b", "c"} {
		answer := answers[name]
		mux.HandleFunc("/repos/alrayyes/"+name+"/hooks", func(w http.ResponseWriter, _ *http.Request) {
			h.mu.Lock()
			h.calls[name]++
			h.mu.Unlock()
			if answer[0] != "" {
				w.WriteHeader(http.StatusForbidden)
				writeJSON(t, w, map[string]any{"message": answer[1]})

				return
			}
			writeJSON(t, w, []map[string]any{})
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func (h *hooksServer) total() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, c := range h.calls {
		n += c
	}

	return n
}

// A GitHub App without permission to read hooks is refused on every repo with
// the same answer, so it is learned once and not asked again for a while
// (#894). Production made about 50 of these calls per refresh, each also
// writing a request-log row, and the refresh took 25 to 37 seconds.
func TestFetch_WebhookChecks_DenialIsRemembered(t *testing.T) {
	t.Parallel()

	denied := [2]string{"403", "Resource not accessible by integration"}
	newClient := func(srv *httptest.Server) *github.Client {
		c := github.NewClient("test-token", "", srv.URL)
		c.SetWebhookPath("/api/webhooks/github/tok123")

		return c
	}

	t.Run("an app that can't read hooks costs no further calls", func(t *testing.T) {
		t.Parallel()
		h := &hooksServer{}
		client := newClient(h.start(t, map[string][2]string{"a": denied, "b": denied, "c": denied}))

		client.Fetch(t.Context())
		afterFirst := h.total()
		client.Fetch(t.Context())
		client.Fetch(t.Context())

		assert.Equal(t, afterFirst, h.total(), "the second and third refresh make none of those calls")
		assert.LessOrEqual(t, afterFirst, 3)
	})

	t.Run("a repo the token can't administer is remembered by itself", func(t *testing.T) {
		t.Parallel()
		h := &hooksServer{}
		client := newClient(h.start(t, map[string][2]string{"b": {"403", "Must have admin rights to Repository."}}))

		client.Fetch(t.Context())
		client.Fetch(t.Context())

		assert.Equal(t, 1, h.calls["b"], "asked once")
		assert.Equal(t, 2, h.calls["a"], "the others are still checked every refresh")
		assert.Equal(t, 2, h.calls["c"])
	})

	t.Run("the denial expires, so a granted permission is noticed", func(t *testing.T) {
		t.Parallel()
		h := &hooksServer{}
		client := newClient(h.start(t, map[string][2]string{"a": denied, "b": denied, "c": denied}))
		client.SetWebhookDenialTTL(20 * time.Millisecond)

		client.Fetch(t.Context())
		afterFirst := h.total()
		time.Sleep(60 * time.Millisecond)
		client.Fetch(t.Context())

		assert.Greater(t, h.total(), afterFirst)
	})
}
