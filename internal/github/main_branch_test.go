package github_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// branchRef is a repo's defaultBranchRef the way GraphQL answers it, with the
// given check rollup (nil for a commit no check ran on).
func branchRef(rollup map[string]any) map[string]any {
	commit := map[string]any{
		"oid": "0123456789abcdef0123456789abcdef01234567", "abbreviatedOid": "0123456",
		"messageHeadline": "fix: stop the thing", "url": "https://github.com/alrayyes/a/commit/0123456",
		"committedDate": "2026-10-10T09:00:00Z",
		"author":        map[string]any{"name": "Ryan Kes", "user": map[string]any{"login": "alrayyes"}},
	}
	if rollup != nil {
		commit["statusCheckRollup"] = rollup
	}

	return map[string]any{"name": "main", "target": commit}
}

func checkRun(name, conclusion, started, completed string) map[string]any {
	return map[string]any{
		"__typename": "CheckRun", "name": name, "status": "COMPLETED", "conclusion": conclusion,
		"startedAt": started, "completedAt": completed, "detailsUrl": "https://github.com/alrayyes/a/actions/runs/1/job/" + name,
	}
}

func rollupOf(state string, runCounts map[string]int, nodes ...map[string]any) map[string]any {
	counts := []map[string]any{}
	for s, n := range runCounts {
		counts = append(counts, map[string]any{"state": s, "count": n})
	}

	return map[string]any{"state": state, "contexts": map[string]any{
		"checkRunCountsByState": counts, "statusContextCountsByState": []map[string]any{}, "nodes": nodes,
	}}
}

// tokenFetchWith serves one repo whose defaultBranchRef is ref and returns
// the single default-branch row a Fetch produced, and the query it posted.
func tokenFetchWith(t *testing.T, ref any) (dashboard.MainBranch, string) {
	t.Helper()

	var query string
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		query = readGraphQLRequest(t, r).Query
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
			"viewer": map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false},
				"nodes": []map[string]any{{
					"name": "a", "url": "https://github.com/alrayyes/a", "viewerPermission": "WRITE",
					"owner":            map[string]any{"login": "alrayyes"},
					"pullRequests":     map[string]any{"nodes": []map[string]any{}},
					"issues":           map[string]any{"nodes": []map[string]any{}},
					"defaultBranchRef": ref,
				}},
			}},
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())
	require.True(t, result.Health.Reachable)
	require.Len(t, result.MainBranches, 1, "one row per tracked repo")

	return result.MainBranches[0], query
}

func TestFetch_MainBranch(t *testing.T) {
	t.Parallel()

	t.Run("a red check fails the branch and names the job", func(t *testing.T) {
		t.Parallel()
		row, _ := tokenFetchWith(t, branchRef(rollupOf("FAILURE", map[string]int{"FAILURE": 1, "SUCCESS": 1},
			checkRun("lint", "SUCCESS", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z"),
			checkRun("test", "FAILURE", "2026-10-10T09:01:00Z", "2026-10-10T09:05:30Z"),
		)))

		assert.Equal(t, dashboard.MainBranchFailed, row.Status)
		assert.Equal(t, []string{"test"}, row.FailingJobs)
		assert.Equal(t, "https://github.com/alrayyes/a/actions/runs/1/job/test", row.RunURL, "the failed job's page")
	})

	t.Run("names the repo, the branch and the commit", func(t *testing.T) {
		t.Parallel()
		row, _ := tokenFetchWith(t, branchRef(rollupOf("SUCCESS", map[string]int{"SUCCESS": 1})))

		assert.Equal(t, dashboard.ForgeGitHub, row.Forge)
		assert.Equal(t, "alrayyes/a", row.FullName)
		assert.Equal(t, "https://github.com/alrayyes/a", row.URL)
		assert.Equal(t, "main", row.Branch)
		require.NotNil(t, row.Commit)
		assert.Equal(t, "0123456", row.Commit.SHA)
		assert.Equal(t, "fix: stop the thing", row.Commit.Subject)
		assert.Equal(t, "alrayyes", row.Commit.Author, "the login, not the name on the commit")
		assert.Equal(t, time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC), *row.Commit.CommittedAt)
	})

	t.Run("a commit whose author has no GitHub login names the author on the commit", func(t *testing.T) {
		t.Parallel()
		ref := branchRef(nil)
		ref["target"].(map[string]any)["author"] = map[string]any{"name": "Ryan Kes", "user": nil}

		row, _ := tokenFetchWith(t, ref)

		assert.Equal(t, "Ryan Kes", row.Commit.Author)
	})

	t.Run("a finished pipeline says when it ended and how long it took", func(t *testing.T) {
		t.Parallel()
		row, _ := tokenFetchWith(t, branchRef(rollupOf("FAILURE", map[string]int{"FAILURE": 1},
			checkRun("lint", "SUCCESS", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z"),
			checkRun("test", "FAILURE", "2026-10-10T09:01:30Z", "2026-10-10T09:05:30Z"),
		)))

		require.NotNil(t, row.FinishedAt)
		assert.Equal(t, time.Date(2026, 10, 10, 9, 5, 30, 0, time.UTC), *row.FinishedAt)
		require.NotNil(t, row.DurationSeconds)
		assert.Equal(t, 270, *row.DurationSeconds, "first start to last finish")
	})

	t.Run("green checks pass the branch with no failing job", func(t *testing.T) {
		t.Parallel()
		row, _ := tokenFetchWith(t, branchRef(rollupOf("SUCCESS", map[string]int{"SUCCESS": 1},
			checkRun("test", "SUCCESS", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z"))))

		assert.Equal(t, dashboard.MainBranchPassed, row.Status)
		assert.Empty(t, row.FailingJobs)
		assert.NotNil(t, row.FailingJobs, "an array, never null")
		assert.Equal(t, "https://github.com/alrayyes/a/actions/runs/1/job/test", row.RunURL)
	})

	t.Run("a pending rollup is running, with no finish time", func(t *testing.T) {
		t.Parallel()
		row, _ := tokenFetchWith(t, branchRef(rollupOf("PENDING", map[string]int{"IN_PROGRESS": 1})))

		assert.Equal(t, dashboard.MainBranchRunning, row.Status)
		assert.Nil(t, row.FinishedAt)
		assert.Nil(t, row.DurationSeconds)
	})

	t.Run("a rollup of cancelled runs next to one still running is running", func(t *testing.T) {
		t.Parallel()
		row, _ := tokenFetchWith(t, branchRef(rollupOf("FAILURE", map[string]int{"CANCELLED": 1, "IN_PROGRESS": 1})))

		assert.Equal(t, dashboard.MainBranchRunning, row.Status, "the same rule a pull request's rollup follows (#722)")
	})

	t.Run("a legacy commit status that failed names its context", func(t *testing.T) {
		t.Parallel()
		rollup := rollupOf("FAILURE", nil, map[string]any{
			"__typename": "StatusContext", "context": "ci/legacy", "state": "FAILURE", "targetUrl": "https://ci.example/1",
		})

		row, _ := tokenFetchWith(t, branchRef(rollup))

		assert.Equal(t, dashboard.MainBranchFailed, row.Status)
		assert.Equal(t, []string{"ci/legacy"}, row.FailingJobs)
		assert.Equal(t, "https://ci.example/1", row.RunURL)
	})

	t.Run("a commit nothing ran on has no pipeline and links to the commit", func(t *testing.T) {
		t.Parallel()
		row, _ := tokenFetchWith(t, branchRef(nil))

		assert.Equal(t, dashboard.MainBranchNone, row.Status)
		assert.Equal(t, "https://github.com/alrayyes/a/commit/0123456/checks", row.RunURL)
		assert.NotNil(t, row.Commit)
	})

	t.Run("an empty repository has a row with no branch and no commit", func(t *testing.T) {
		t.Parallel()
		row, _ := tokenFetchWith(t, nil)

		assert.Equal(t, dashboard.MainBranchNone, row.Status)
		assert.Empty(t, row.Branch)
		assert.Nil(t, row.Commit)
		assert.Equal(t, "https://github.com/alrayyes/a", row.RunURL, "falls back to the repo")
	})

	t.Run("rides the repository query already made, no query of its own", func(t *testing.T) {
		t.Parallel()
		_, query := tokenFetchWith(t, nil)

		assert.Contains(t, query, "defaultBranchRef")
		assert.Contains(t, query, "pullRequests(", "the same query as the pull requests")
	})
}

func TestAppClient_Fetch_ReadsEachRepoDefaultBranch(t *testing.T) {
	t.Parallel()

	var query string
	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID), func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"token": "t", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("/installation/repositories", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "repositories": []map[string]any{
			{"name": "a", "full_name": "alrayyes/a", "html_url": "https://github.com/alrayyes/a", "owner": map[string]any{"login": "alrayyes"}},
		}})
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		query = readGraphQLRequest(t, r).Query
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": map[string]any{"limit": 5000, "cost": 1, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
			"r0": map[string]any{
				"pullRequests": map[string]any{"nodes": []map[string]any{}}, "issues": map[string]any{"nodes": []map[string]any{}},
				"defaultBranchRef": branchRef(rollupOf("SUCCESS", map[string]int{"SUCCESS": 1})),
			},
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	result := client.Fetch(t.Context())

	require.Len(t, result.MainBranches, 1)
	assert.Equal(t, dashboard.MainBranchPassed, result.MainBranches[0].Status)
	assert.Equal(t, "alrayyes/a", result.MainBranches[0].FullName)
	assert.Contains(t, query, "defaultBranchRef")
}

// TestFetch_MainBranch_SkipsCommitsNoCheckRanOn pins #1265. washy-washy-pdf's
// release job pushes "chore(release): 2.6.2 [skip ci]" to main, so the newest
// commit has no check suites and no rollup, while the commit before it
// (322ca56) carries the 11 Actions check runs. The row reads the newest commit
// that a check ran on.
func TestFetch_MainBranch_SkipsCommitsNoCheckRanOn(t *testing.T) {
	t.Parallel()

	checked := map[string]any{
		"oid": "322ca560e61ef0378ee010d60c6c71df9aff2650", "abbreviatedOid": "322ca56",
		"messageHeadline": "perf: count pages without pdf-lib (#131)",
		"url":             "https://github.com/alrayyes/washy-washy-pdf/commit/322ca56",
		"committedDate":   "2026-10-09T09:00:00Z",
		"author":          map[string]any{"name": "Ryan Kes", "user": map[string]any{"login": "alrayyes"}},
		"statusCheckRollup": rollupOf("SUCCESS", map[string]int{"SUCCESS": 8, "SKIPPED": 3},
			checkRun("check", "SUCCESS", "2026-10-09T09:01:00Z", "2026-10-09T09:03:00Z")),
	}
	skipCI := map[string]any{
		"oid": "d77a71648ce53adf4e77dc02ce7c434f55538953", "abbreviatedOid": "d77a716",
		"messageHeadline": "chore(release): 2.6.2 [skip ci]",
		"url":             "https://github.com/alrayyes/washy-washy-pdf/commit/d77a716",
		"committedDate":   "2026-10-09T09:10:00Z", "statusCheckRollup": nil,
	}

	var queries []string
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		query := readGraphQLRequest(t, r).Query
		queries = append(queries, query)
		rate := map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"}
		if strings.Contains(query, "history(") {
			writeJSON(t, w, map[string]any{"data": map[string]any{"rateLimit": rate, "m0": map[string]any{
				"defaultBranchRef": map[string]any{"target": map[string]any{
					"history": map[string]any{"nodes": []map[string]any{skipCI, checked}},
				}},
			}}})

			return
		}
		head := branchRef(nil)
		head["target"] = skipCI
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": rate,
			"viewer": map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false},
				"nodes": []map[string]any{{
					"name": "washy-washy-pdf", "url": "https://github.com/alrayyes/washy-washy-pdf", "viewerPermission": "WRITE",
					"owner":            map[string]any{"login": "alrayyes"},
					"pullRequests":     map[string]any{"nodes": []map[string]any{}},
					"issues":           map[string]any{"nodes": []map[string]any{}},
					"defaultBranchRef": head,
				}},
			}},
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.MainBranches, 1)
	row := result.MainBranches[0]
	assert.Equal(t, dashboard.MainBranchPassed, row.Status)
	require.NotNil(t, row.Commit)
	assert.Equal(t, "322ca56", row.Commit.SHA, "the commit the checks ran on")
	assert.Equal(t, "perf: count pages without pdf-lib (#131)", row.Commit.Subject)
	assert.Len(t, queries, 2, "one extra query, only for the repo whose newest commit has no checks")
}
