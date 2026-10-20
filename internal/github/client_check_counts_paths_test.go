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

// The counts and the overall state have to agree: a pill that says Running
// must never carry a failed count, and a passed one must carry nothing still
// to do. Every combination of the states that matter goes through the real
// mapping, the rollup state worked out the way GitHub does (a failure wins over
// pending, pending over success).
func TestFetch_CheckCountsAgreeWithTheOverallState(t *testing.T) {
	t.Parallel()

	runStates := []string{"SUCCESS", "IN_PROGRESS", "QUEUED", "FAILURE", "CANCELLED", "ACTION_REQUIRED"}
	statusStates := []string{"PENDING", "FAILURE"}
	total := len(runStates) + len(statusStates)

	for mask := 1; mask < 1<<total; mask++ {
		runs := map[string]int{}
		statuses := map[string]int{}
		var name []string
		for i := 0; i < total; i++ {
			if mask&(1<<i) == 0 {
				continue
			}
			if i < len(runStates) {
				runs[runStates[i]] = 1
				name = append(name, runStates[i])
			} else {
				statuses[statusStates[i-len(runStates)]] = 1
				name = append(name, "status:"+statusStates[i-len(runStates)])
			}
		}
		t.Run(strings.Join(name, "+"), func(t *testing.T) {
			t.Parallel()

			pr := pullRequestFromGraphQLRollup(t, rollupFixture(githubRollupState(runs, statuses), runs, statuses))

			switch pr.CI {
			case dashboard.CIPending:
				assert.Zero(t, pr.Checks.Failed, "a pending pull request shows no failed count: %+v", pr.Checks)
			case dashboard.CISuccess:
				assert.Equal(t, dashboard.CheckCounts{Passed: pr.Checks.Passed}, pr.Checks, "a passed pull request has nothing left to do")
			case dashboard.CIFailure:
				heldOrCancelled := runs["ACTION_REQUIRED"] > 0 || runs["CANCELLED"] > 0
				assert.True(t, pr.Checks.Failed > 0 || heldOrCancelled,
					"a failure with no failed count must come from a held or cancelled run: %+v", pr.Checks)
			}
		})
	}
}

// githubRollupState is GitHub's own combined state for a commit's contexts: any
// failure, a cancelled or held run included (#722), wins over anything pending,
// and pending wins over success.
func githubRollupState(runs, statuses map[string]int) string {
	switch {
	case runs["FAILURE"] > 0, runs["CANCELLED"] > 0, runs["ACTION_REQUIRED"] > 0, statuses["FAILURE"] > 0:
		return "FAILURE"
	case runs["IN_PROGRESS"] > 0, runs["QUEUED"] > 0, statuses["PENDING"] > 0:
		return "PENDING"
	default:
		return "SUCCESS"
	}
}

// A rollup of an earlier commit says nothing about the head's checks, so its
// counts are not shown: the same rule that reads the overall state as pending
// until the commit lists agree (#1311).
func TestFetch_RollupOfAnEarlierCommit_HasNoCheckCounts(t *testing.T) {
	t.Parallel()

	srv := staleRollupServerWith(t, rollupFixture("SUCCESS", map[string]int{"SUCCESS": 5}, nil), "BLOCKED", "head", "earlier", nil)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CheckCounts{}, result.PullRequests[0].Checks)
}

// The counts of the head commit's own rollup are kept.
func TestFetch_RollupOfTheHeadCommit_KeepsItsCheckCounts(t *testing.T) {
	t.Parallel()

	srv := staleRollupServerWith(t, rollupFixture("SUCCESS", map[string]int{"SUCCESS": 5}, nil), "CLEAN", "head", "head", nil)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CheckCounts{Passed: 5}, result.PullRequests[0].Checks)
}

// A webhook refresh swaps one repo's pull requests in for the last full fetch,
// so its query is a selection of its own and has to carry the counts too.
func TestFetchRepo_CarriesTheCheckCounts(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if q := readGraphQLRequest(t, r).Query; strings.Contains(q, "pullRequests(") {
			assert.Contains(t, q, "checkRunCountsByState", "the query asks for the per-state counts")
			assert.Contains(t, q, "statusContextCountsByState")
		}
		node := stalePRNode("CLEAN", "head", "head", rollupFixture("PENDING", map[string]int{"SUCCESS": 4, "IN_PROGRESS": 1, "QUEUED": 2}, nil))
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"repository": map[string]any{
					"pullRequests": map[string]any{"nodes": []map[string]any{node}},
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
	assert.Equal(t, dashboard.CheckCounts{Passed: 4, Running: 1, Waiting: 2}, prs[0].Checks)
}

// A GitHub App account reads its pull requests through a batched per-repo
// query, a third selection of the same fields, so it has to carry the counts.
func TestAppClient_Fetch_CarriesTheCheckCounts(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID), func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"token":      "installation-token-value",
			"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("/installation/repositories", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"total_count": 1,
			"repositories": []map[string]any{
				{"name": "repo-one", "full_name": "alrayyes/repo-one", "html_url": "https://github.com/alrayyes/repo-one", "fork": false, "archived": false, "owner": map[string]any{"login": "alrayyes"}},
			},
		})
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if q := readGraphQLRequest(t, r).Query; strings.Contains(q, "pullRequests(") {
			assert.Contains(t, q, "checkRunCountsByState", "the App query asks for the per-state counts")
			assert.Contains(t, q, "statusContextCountsByState")
		}
		node := stalePRNode("CLEAN", "head", "head", rollupFixture("FAILURE", map[string]int{"SUCCESS": 3, "FAILURE": 1}, map[string]int{"SUCCESS": 2}))
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "cost": 1, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
				"r0": map[string]any{
					"pullRequests": map[string]any{"nodes": []map[string]any{node}},
					"issuesTotal":  map[string]any{"totalCount": 0},
					"issues":       map[string]any{"nodes": []map[string]any{}},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	result := client.Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, dashboard.CheckCounts{Passed: 5, Failed: 1}, result.PullRequests[0].Checks)
}
