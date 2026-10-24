package forgejo_test

import (
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The tickets a description mentions without closing them, read the way
// Forgejo links them, so a dialog can list them.
func TestListOpenPullRequests_ReadsTheMentionsInTheDescription(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	mentioning := reviewPR(1, false, "2026-09-02T00:00:00Z")
	mentioning["body"] = "Closes #12. Refs #13 and alrayyes/other#3."
	plain := reviewPR(2, false, "2026-09-02T00:00:00Z")
	plain["body"] = "Nothing to see"
	srv := reviewPRServer(t, []map[string]any{mentioning, plain}, map[int][]map[string]any{1: {}, 2: {}}, &calls)
	defer srv.Close()

	prs, err := forgejo.NewClient(srv.URL, "test-token", "").ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, prs, 2)
	// The closing "Closes #12" is read as a mention too; the dashboard takes
	// it off through ClosesIssues, which depends on the branch aimed at.
	assert.Equal(t, []dashboard.IssueRef{
		{Repo: "alrayyes/a", Number: 12, URL: srv.URL + "/alrayyes/a/issues/12"},
		{Repo: "alrayyes/a", Number: 13, URL: srv.URL + "/alrayyes/a/issues/13"},
		{Repo: "alrayyes/other", Number: 3, URL: srv.URL + "/alrayyes/other/issues/3"},
	}, prs[0].MentionsIssues)
	assert.Equal(t, []dashboard.IssueRef{}, prs[1].MentionsIssues, "never null: an empty list")
}
