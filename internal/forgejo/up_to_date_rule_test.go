package forgejo_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// upToDateForge serves one open pull request on main, behind its base when
// behind is true, and answers the branch protection list with status and
// rules. It counts the protection reads so a test can assert on caching.
func upToDateForge(t *testing.T, behind bool, status int, rules []map[string]any, reads *atomic.Int32) *forgejo.Client {
	t.Helper()

	return upToDateForgeWith(t, behind, status, rules, reads, nil)
}

func upToDateForgeWith(t *testing.T, behind bool, status int, rules []map[string]any, reads *atomic.Int32, onProtection func(*http.Request)) *forgejo.Client {
	t.Helper()
	mergeBase := "oldbase"
	if !behind {
		mergeBase = "newbase"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{{
			"number": 12, "title": "t", "html_url": "https://git.example/alrayyes/a/pulls/12",
			"user": map[string]string{"login": "ryankes"}, "labels": []map[string]string{}, "mergeable": true,
			"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
			"merge_base": mergeBase,
			"head":       map[string]string{"sha": "cafef00d", "ref": "feature"},
			"base":       map[string]string{"sha": "newbase", "ref": "main"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "success", "statuses": []map[string]any{}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/branch_protections", func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		if onProtection != nil {
			onProtection(r)
		}
		w.WriteHeader(status)
		writeJSON(t, w, rules)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func listOnly(t *testing.T, c *forgejo.Client) dashboard.PullRequest {
	t.Helper()
	prs, err := c.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	require.Len(t, prs, 1)

	return prs[0]
}

func TestListOpenPullRequests_BehindWhereTheRuleBlocksOutdatedBranches_SaysSo(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32
	rules := []map[string]any{{"rule_name": "main", "block_on_outdated_branch": true}}

	pr := listOnly(t, upToDateForge(t, true, http.StatusOK, rules, &reads))

	require.NotNil(t, pr.BaseRequiresUpToDate)
	assert.True(t, *pr.BaseRequiresUpToDate)
}

func TestListOpenPullRequests_BehindWhereTheRuleAllowsOutdatedBranches_SaysSo(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32
	rules := []map[string]any{{"rule_name": "main", "block_on_outdated_branch": false}}

	pr := listOnly(t, upToDateForge(t, true, http.StatusOK, rules, &reads))

	require.NotNil(t, pr.BaseRequiresUpToDate)
	assert.False(t, *pr.BaseRequiresUpToDate)
}

func TestListOpenPullRequests_BehindWithNoRuleOnTheBranch_SaysItIsNotRequired(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32

	pr := listOnly(t, upToDateForge(t, true, http.StatusOK, []map[string]any{}, &reads))

	require.NotNil(t, pr.BaseRequiresUpToDate)
	assert.False(t, *pr.BaseRequiresUpToDate)
}

func TestListOpenPullRequests_BehindWhenProtectionIsUnreadable_LeavesTheRuleUnknown(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32

	pr := listOnly(t, upToDateForge(t, true, http.StatusForbidden, nil, &reads))

	assert.Nil(t, pr.BaseRequiresUpToDate, "nothing is guessed")
}

func TestListOpenPullRequests_UpToDateRule_IsReadOncePerBranchAcrossRefreshes(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32
	client := upToDateForge(t, true, http.StatusOK, []map[string]any{{"rule_name": "main", "block_on_outdated_branch": true}}, &reads)

	listOnly(t, client)
	listOnly(t, client)

	assert.Equal(t, int32(1), reads.Load())
}

func TestListOpenPullRequests_NotBehind_DoesNotReadTheRule(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32

	pr := listOnly(t, upToDateForge(t, false, http.StatusOK, []map[string]any{{"rule_name": "main", "block_on_outdated_branch": true}}, &reads))

	assert.Nil(t, pr.BaseRequiresUpToDate)
	assert.Zero(t, reads.Load())
}

func TestListOpenPullRequests_UpToDateRule_ACancelledReadIsNotCachedAsUnknown(t *testing.T) {
	t.Parallel()
	var reads atomic.Int32
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	client := upToDateForgeWith(t, true, http.StatusOK, []map[string]any{{"rule_name": "main", "block_on_outdated_branch": true}}, &reads, func(r *http.Request) {
		if reads.Load() == 1 {
			cancel()
			<-r.Context().Done()
		}
	})

	_, _ = client.ListOpenPullRequests(ctx, "alrayyes", "a", "alrayyes/a")
	pr := listOnly(t, client)

	require.NotNil(t, pr.BaseRequiresUpToDate)
	assert.True(t, *pr.BaseRequiresUpToDate)
	assert.Equal(t, int32(2), reads.Load())
}
