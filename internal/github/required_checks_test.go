package github_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// unreportedChecksServer serves one open pull request whose GitHub rollup is
// SUCCESS and whose merge state is mergeState, on a base branch that requires
// the contexts in required while the head has only reported the runs named in
// reported (alrayyes/scaffold-deb-package#25: five required, one reported).
// It counts the check-run lookups so a test can assert on caching.
func unreportedChecksServer(t *testing.T, mergeState string, required, reported []string, lookups *atomic.Int32, statuses ...string) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "behindBy") {
			writeJSON(t, w, map[string]any{"data": map[string]any{}})

			return
		}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes": []map[string]any{{
							"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "ADMIN",
							"owner": map[string]any{"login": "alrayyes"},
							"pullRequests": map[string]any{"nodes": []map[string]any{{
								"number": 25, "title": "bump", "url": "https://github.com/alrayyes/a/pull/25",
								"isDraft": false, "author": map[string]any{"login": "dependabot"},
								"labels":    map[string]any{"nodes": []map[string]any{}},
								"createdAt": "2026-10-12T12:27:00Z", "updatedAt": "2026-10-12T12:28:00Z",
								"mergeStateStatus": mergeState, "headRefOid": "cafef00d", "baseRefName": "main",
								"commits": map[string]any{"nodes": []map[string]any{
									{"commit": map[string]any{"statusCheckRollup": rollupFixture("SUCCESS", map[string]int{"SUCCESS": len(reported)}, nil)}},
								}},
							}}},
							"issues": map[string]any{"nodes": []map[string]any{}},
						}},
					},
				},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/branches/main/protection/required_status_checks", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"strict": false, "contexts": required})
	})
	mux.HandleFunc("/repos/alrayyes/a/rules/branches/main", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		lookups.Add(1)
		runs := make([]map[string]any, 0, len(reported))
		for _, name := range reported {
			runs = append(runs, map[string]any{"name": name, "status": "completed", "conclusion": "success"})
		}
		writeJSON(t, w, map[string]any{"total_count": len(runs), "check_runs": runs})
	})

	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		list := make([]map[string]any, 0, len(statuses))
		for _, name := range statuses {
			list = append(list, map[string]any{"context": name, "state": "success"})
		}
		writeJSON(t, w, map[string]any{"state": "success", "statuses": list})
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func TestFetch_RequiredCheckNotYetReported_IsPending(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	srv := unreportedChecksServer(t, "BLOCKED",
		[]string{"build", "check", "commits", "prose", "secrets"}, []string{"check"}, &lookups)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CIPending, result.PullRequests[0].CI,
		"GitHub's rollup counts only contexts that exist, so four required checks that haven't started must keep it pending")
}

func TestFetch_EveryRequiredCheckReported_StaysSuccess(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	srv := unreportedChecksServer(t, "BLOCKED",
		[]string{"build", "check"}, []string{"build", "check", "extra"}, &lookups)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CISuccess, result.PullRequests[0].CI)
}

func TestFetch_CleanPullRequest_SkipsTheRequiredChecksLookup(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	srv := unreportedChecksServer(t, "CLEAN", []string{"build", "check"}, []string{"check"}, &lookups)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CISuccess, result.PullRequests[0].CI,
		"GitHub says CLEAN, so every required check has passed; no extra requests")
	assert.Zero(t, lookups.Load())
}

func TestFetch_CompleteRequiredChecks_AreNotLookedUpAgainForTheSameCommit(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	srv := unreportedChecksServer(t, "BLOCKED", []string{"check"}, []string{"check"}, &lookups)
	client := github.NewClient("test-token", "", srv.URL)

	client.Fetch(t.Context())
	client.Fetch(t.Context())

	assert.EqualValues(t, 1, lookups.Load(), "a commit whose required checks all reported can't regress")
}

// A required commit status (codecov/patch, a third-party CI) reports beside
// the Actions runs. It is a reported context, not a missing one.
func TestFetch_RequiredStatusContextBesideCheckRuns_CountsAsReported(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	srv := unreportedChecksServer(t, "BLOCKED",
		[]string{"check", "codecov/patch"}, []string{"check"}, &lookups, "codecov/patch")

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CISuccess, result.PullRequests[0].CI)
}

func TestFetch_RequiredStatusContextNotYetReported_IsPending(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	srv := unreportedChecksServer(t, "BLOCKED",
		[]string{"check", "codecov/patch"}, []string{"check"}, &lookups)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CIPending, result.PullRequests[0].CI)
}

// partialRequiredServer is unreportedChecksServer for the cases it can't
// express: protection that fails, and check runs spread over two pages.
type partialRequiredServer struct {
	protectionFails atomic.Bool
	protectionCalls *atomic.Int32
	protection      []string
	rulesets        []string
	pages           [][]string
}

func (p *partialRequiredServer) start(t *testing.T) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "behindBy") {
			writeJSON(t, w, map[string]any{"data": map[string]any{}})

			return
		}
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
			"viewer": map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false},
				"nodes": []map[string]any{{
					"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "ADMIN",
					"owner": map[string]any{"login": "alrayyes"},
					"pullRequests": map[string]any{"nodes": []map[string]any{{
						"number": 25, "title": "bump", "url": "https://github.com/alrayyes/a/pull/25",
						"isDraft": false, "author": map[string]any{"login": "dependabot"},
						"labels":    map[string]any{"nodes": []map[string]any{}},
						"createdAt": "2026-10-12T12:27:00Z", "updatedAt": "2026-10-12T12:28:00Z",
						"mergeStateStatus": "BLOCKED", "headRefOid": "cafef00d", "baseRefName": "main",
						"commits": map[string]any{"nodes": []map[string]any{
							{"commit": map[string]any{"statusCheckRollup": rollupFixture("SUCCESS", map[string]int{"SUCCESS": 1}, nil)}},
						}},
					}}},
					"issues": map[string]any{"nodes": []map[string]any{}},
				}},
			}},
		}})
	})
	mux.HandleFunc("/repos/alrayyes/a/branches/main/protection/required_status_checks", func(w http.ResponseWriter, _ *http.Request) {
		if p.protectionCalls != nil {
			p.protectionCalls.Add(1)
		}
		if p.protectionFails.Load() {
			http.Error(w, `{"message":"boom"}`, http.StatusInternalServerError)

			return
		}
		writeJSON(t, w, map[string]any{"strict": false, "contexts": p.protection})
	})
	mux.HandleFunc("/repos/alrayyes/a/rules/branches/main", func(w http.ResponseWriter, _ *http.Request) {
		rules := []map[string]any{}
		if len(p.rulesets) > 0 {
			checks := make([]map[string]any, 0, len(p.rulesets))
			for _, name := range p.rulesets {
				checks = append(checks, map[string]any{"context": name})
			}
			rules = append(rules, map[string]any{"type": "required_status_checks", "parameters": map[string]any{"required_status_checks": checks}})
		}
		writeJSON(t, w, rules)
	})
	var base string
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, r *http.Request) {
		page := 1
		if r.URL.Query().Get("page") == "2" {
			page = 2
		}
		if page < len(p.pages) {
			w.Header().Set("Link", `<`+base+`/repos/alrayyes/a/commits/cafef00d/check-runs?page=`+string(rune('0'+page+1))+`>; rel="next"`)
		}
		runs := []map[string]any{}
		for _, name := range p.pages[page-1] {
			runs = append(runs, map[string]any{"name": name, "status": "completed", "conclusion": "success"})
		}
		writeJSON(t, w, map[string]any{"total_count": len(runs), "check_runs": runs})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "success", "statuses": []map[string]any{}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	base = srv.URL

	return srv
}

// A lookup that failed leaves the required set partial. The commit must not be
// remembered as complete on that evidence, or the context the failed lookup
// would have named is never checked again for that commit.
func TestFetch_RequiredLookupThatFailed_NeverMarksACommitComplete(t *testing.T) {
	t.Parallel()

	srvData := &partialRequiredServer{protection: []string{"check", "codecov/patch"}, rulesets: []string{"check"}, pages: [][]string{{"check"}}}
	srvData.protectionFails.Store(true)
	srv := srvData.start(t)
	client := github.NewClient("test-token", "", srv.URL)

	first := client.Fetch(t.Context())
	require.Len(t, first.PullRequests, 1)
	assert.Equal(t, dashboard.CISuccess, first.PullRequests[0].CI, "all the known required checks reported")

	srvData.protectionFails.Store(false)
	client.ExpirePartialRequiredContexts()
	second := client.Fetch(t.Context())

	require.Len(t, second.PullRequests, 1)
	assert.Equal(t, dashboard.CIPending, second.PullRequests[0].CI,
		"protection now answers and names codecov/patch, which never reported")
}

// A required check past the first page of check runs is reported, not missing.
func TestFetch_RequiredCheckOnTheSecondPageOfRuns_CountsAsReported(t *testing.T) {
	t.Parallel()

	srvData := &partialRequiredServer{protection: []string{"deploy"}, pages: [][]string{{"build", "lint"}, {"deploy"}}}
	srv := srvData.start(t)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CISuccess, result.PullRequests[0].CI)
}

// Branch protection that can't be read (no admin scope) must not be asked
// again on every poll for every blocked pull request: a partial answer is
// remembered briefly, just never as a reason to call a commit complete.
func TestFetch_UnreadableProtection_IsNotAskedAgainOnTheNextPoll(t *testing.T) {
	t.Parallel()

	var protectionCalls atomic.Int32
	srvData := &partialRequiredServer{protection: []string{"check"}, rulesets: []string{"check"}, pages: [][]string{{"check"}}}
	srvData.protectionFails.Store(true)
	srvData.protectionCalls = &protectionCalls
	srv := srvData.start(t)
	client := github.NewClient("test-token", "", srv.URL)

	client.Fetch(t.Context())
	client.Fetch(t.Context())

	assert.EqualValues(t, 1, protectionCalls.Load())
}
