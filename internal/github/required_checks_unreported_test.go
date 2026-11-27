package github_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// justPushed is a pull request GitHub blocks right after a push, and what the
// forge says about its base branch (#5108).
type justPushed struct {
	// required is what the base branch requires.
	required []string
	// passed names the head commit's finished check runs. With none, the commit
	// has no rollup at all.
	passed []string
	// adminRefused answers the protection endpoint as it does for a credential
	// without admin rights, which can still read the branch itself.
	adminRefused bool
	// branchRefusal fails the branch read too, so the names can't be known.
	branchRefusal int
	// branchRemaining is the request budget the refused branch read reports.
	branchRemaining string
	// branchRenamed redirects the branch read, as GitHub does after a rename.
	branchRenamed  bool
	reviewDecision string

	branchReads atomic.Int32
}

func (j *justPushed) fetch(t *testing.T) dashboard.PullRequest {
	t.Helper()

	result := github.NewClient("test-token", "", j.start(t).URL).Fetch(t.Context())
	require.Len(t, result.PullRequests, 1)

	return result.PullRequests[0]
}

func (j *justPushed) graphQL(t *testing.T) http.HandlerFunc {
	t.Helper()

	var rollup any
	if len(j.passed) > 0 {
		rollup = rollupFixture("SUCCESS", map[string]int{"SUCCESS": len(j.passed)}, nil)
	}
	pr := map[string]any{
		"number": 25, "title": "bump", "url": "https://github.com/alrayyes/a/pull/25",
		"author": map[string]any{"login": "alrayyes"}, "labels": map[string]any{"nodes": []map[string]any{}},
		"createdAt": "2026-10-12T12:27:00Z", "updatedAt": "2026-10-12T12:28:00Z",
		"mergeStateStatus": "BLOCKED", "headRefOid": "cafef00d", "baseRefName": "main",
		"commits":      map[string]any{"nodes": []map[string]any{{"commit": map[string]any{"statusCheckRollup": rollup}}}},
		"changedFiles": 1,
	}
	if j.reviewDecision != "" {
		pr["reviewDecision"] = j.reviewDecision
	}

	return func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(readGraphQLRequest(t, r).Query, "behindBy") {
			writeJSON(t, w, map[string]any{"data": map[string]any{}})

			return
		}
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
			"viewer": map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false},
				"nodes": []map[string]any{{
					"name": "a", "viewerPermission": "WRITE",
					"owner":        map[string]any{"login": "alrayyes"},
					"pullRequests": map[string]any{"nodes": []map[string]any{pr}},
					"issues":       map[string]any{"nodes": []map[string]any{}},
				}},
			}},
		}})
	}
}

func (j *justPushed) start(t *testing.T) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", j.graphQL(t))
	mux.HandleFunc("/repos/alrayyes/a/pulls/25", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"head": map[string]any{"sha": "cafef00d"}, "base": map[string]any{"ref": "main"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/branches/main/protection/required_status_checks", func(w http.ResponseWriter, _ *http.Request) {
		if j.adminRefused {
			http.Error(w, `{"message":"Not Found"}`, http.StatusNotFound)

			return
		}
		writeJSON(t, w, map[string]any{"strict": false, "contexts": j.required})
	})
	mux.HandleFunc("/repos/alrayyes/a/branches/main", func(w http.ResponseWriter, r *http.Request) {
		if j.branchRenamed {
			http.Redirect(w, r, "/repos/alrayyes/a/branches/trunk", http.StatusMovedPermanently)

			return
		}
		j.branch(t)(w, r)
	})
	mux.HandleFunc("/repos/alrayyes/a/branches/trunk", j.branch(t))
	mux.HandleFunc("/repos/alrayyes/a/rules/branches/main", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		runs := []map[string]any{}
		for _, name := range j.passed {
			runs = append(runs, completedRun(name))
		}
		writeJSON(t, w, map[string]any{"total_count": len(runs), "check_runs": runs})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "pending", "statuses": []map[string]any{}})
	})
	mux.HandleFunc("/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 0, "workflow_runs": []map[string]any{}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

// branch is GitHub's "get a branch" answer, readable without admin rights.
func (j *justPushed) branch(t *testing.T) http.HandlerFunc {
	t.Helper()

	return func(w http.ResponseWriter, _ *http.Request) {
		j.branchReads.Add(1)
		if j.branchRefusal != 0 {
			if j.branchRemaining != "" {
				w.Header().Set("X-RateLimit-Limit", "5000")
				w.Header().Set("X-RateLimit-Remaining", j.branchRemaining)
				w.Header().Set("X-RateLimit-Reset", "1789000000")
			}
			http.Error(w, `{"message":"refused"}`, j.branchRefusal)

			return
		}
		level := "off"
		if len(j.required) > 0 {
			level = "everyone"
		}
		writeJSON(t, w, map[string]any{"name": "main", "protected": true, "protection": map[string]any{
			"enabled":                len(j.required) > 0,
			"required_status_checks": map[string]any{"enforcement_level": level, "contexts": j.required},
		}})
	}
}

func mergeBlockedCode(t *testing.T, pr dashboard.PullRequest) dashboard.ActionCode {
	t.Helper()

	for _, a := range dashboard.AllowedActions(pr, nil) {
		if a.Action == dashboard.ActionMerge {
			require.NotNil(t, a.Blocked)

			return a.Blocked.Code
		}
	}
	require.Fail(t, "Merge isn't offered")

	return ""
}

func TestFetch_BlockedBeforeAnyRequiredCheckReports_WaitsForChecks(t *testing.T) {
	t.Parallel()

	cases := map[string]*justPushed{
		"protection readable": {required: []string{"ci"}},
		"no admin rights":     {required: []string{"ci"}, adminRefused: true},
		"review also due":     {required: []string{"ci"}, adminRefused: true, reviewDecision: "REVIEW_REQUIRED"},
	}
	for name, j := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			pr := j.fetch(t)

			assert.Equal(t, dashboard.CIPending, pr.CI)
			assert.Equal(t, []string{"ci"}, pr.PendingChecks)
			assert.Equal(t, dashboard.ActionChecksPending, mergeBlockedCode(t, pr))
		})
	}
}

func TestFetch_BlockedWithOnlyOtherChecksPassed_WaitsForTheRequiredOne(t *testing.T) {
	t.Parallel()

	j := &justPushed{required: []string{"ci"}, passed: []string{"title"}, adminRefused: true, reviewDecision: "REVIEW_REQUIRED"}
	pr := j.fetch(t)

	assert.Equal(t, dashboard.CIPending, pr.CI)
	assert.Equal(t, dashboard.ActionChecksPending, mergeBlockedCode(t, pr))
}

func TestFetch_BlockedWithEveryRequiredCheckPassed_IsBlockedByTheForge(t *testing.T) {
	t.Parallel()

	j := &justPushed{required: []string{"ci"}, passed: []string{"ci"}, adminRefused: true, reviewDecision: "REVIEW_REQUIRED"}
	pr := j.fetch(t)

	assert.Equal(t, dashboard.CISuccess, pr.CI)
	assert.Equal(t, dashboard.ActionBlockedByProtection, mergeBlockedCode(t, pr))
}

// With no check at all, only a required check the dashboard knows by name makes
// it pending. A repo with no CI blocked for some other reason must not read as
// waiting for CI for good.
func TestFetch_BlockedWithNoCheckAndNoKnownRequiredCheck_IsBlockedByTheForge(t *testing.T) {
	t.Parallel()

	cases := map[string]*justPushed{
		"nothing required":      {},
		"nothing required here": {adminRefused: true},
		"names can't be read":   {required: []string{"ci"}, adminRefused: true, branchRefusal: http.StatusNotFound},
	}
	for name, j := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			pr := j.fetch(t)

			assert.Equal(t, dashboard.CINone, pr.CI)
			assert.Equal(t, dashboard.ActionBlockedByProtection, mergeBlockedCode(t, pr))
		})
	}
}

func TestListChecks_WithoutAdminRights_ListsTheRequiredCheckAsNotReported(t *testing.T) {
	t.Parallel()

	j := &justPushed{required: []string{"ci"}, passed: []string{"title"}, adminRefused: true}
	checks, err := github.NewClient("test-token", "", j.start(t).URL).ListChecks(t.Context(), "alrayyes", "a", 25)
	require.NoError(t, err)

	var notReported []string
	for _, c := range checks {
		if c.NotReported {
			notReported = append(notReported, c.Name)
		}
	}
	assert.Equal(t, []string{"ci"}, notReported)
}

// The request log has to say what the forge answered, or a refused or throttled
// branch read looks like an unreachable forge.
func TestFetch_RefusedBranchRead_IsRecordedWithItsStatus(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		status    int
		remaining string
		outcome   dashboard.ForgeErrorKind
	}{
		"not found":    {status: http.StatusNotFound, outcome: dashboard.ForgeErrorNotFound},
		"rate limited": {status: http.StatusForbidden, remaining: "0", outcome: dashboard.ForgeErrorRateLimited},
		"bad gateway":  {status: http.StatusBadGateway, outcome: dashboard.ForgeErrorUpstream},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			j := &justPushed{required: []string{"ci"}, adminRefused: true, branchRefusal: tc.status, branchRemaining: tc.remaining}
			rec := &fakeRecorder{}
			github.NewClient("test-token", "", j.start(t).URL, rec).Fetch(t.Context())

			var branch []requestlog.Entry
			for _, e := range rec.all() {
				if e.Endpoint == "/repos/alrayyes/a/branches/main" {
					branch = append(branch, e)
				}
			}
			require.Len(t, branch, 1)
			assert.Equal(t, tc.status, branch[0].StatusCode)
			assert.Equal(t, string(tc.outcome), branch[0].Outcome)
			if tc.remaining != "" {
				require.NotNil(t, branch[0].RateLimitRemaining)
				assert.Zero(t, *branch[0].RateLimitRemaining)
			}
		})
	}
}

func TestFetch_RenamedBaseBranch_FollowsTheRedirect(t *testing.T) {
	t.Parallel()

	j := &justPushed{required: []string{"ci"}, adminRefused: true, branchRenamed: true}
	pr := j.fetch(t)

	assert.Equal(t, []string{"ci"}, pr.PendingChecks)
}

func TestFetch_ReadableProtection_DoesNotReadTheBranchToo(t *testing.T) {
	t.Parallel()

	j := &justPushed{required: []string{"ci"}}
	j.fetch(t)

	assert.Zero(t, j.branchReads.Load())
}
