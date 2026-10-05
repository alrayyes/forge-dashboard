package api_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// UpdateBranch makes botSource a dashboard.BranchUpdater too, so the same
// one-pull-request board serves the Update branch tests (#982).
func (s *botSource) UpdateBranch(context.Context, string, string, int) (bool, error) {
	return false, s.fail
}

func updateRequestOnBoard(t *testing.T, srv *httptest.Server, cookie *http.Cookie) any {
	t.Helper()

	prs, _ := fetchDashboard(t, srv.URL, cookie)["pullRequests"].([]any)
	require.Len(t, prs, 1)

	return prs[0].(map[string]any)["updateRequest"]
}

func TestDashboard_UpdateRequest_AcceptedUpdateBranch_ShowsOnThePullRequest(t *testing.T) {
	t.Parallel()

	srv, cookie := botBoard(t, nil)
	require.Nil(t, updateRequestOnBoard(t, srv, cookie), "no request yet")

	resp := postUpdatePullRequestBranch(t, srv.URL, cookie, "github", "alrayyes/a", 5)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	got, ok := updateRequestOnBoard(t, srv, cookie).(map[string]any)
	require.True(t, ok, "the pull request should carry updateRequest")
	assert.Equal(t, "queued", got["phase"])
	assert.NotEmpty(t, got["requestedAt"])
	assert.NotEmpty(t, got["expiresAt"])
}

func TestDashboard_UpdateRequest_RefusedUpdateBranch_LeavesNoRequest(t *testing.T) {
	t.Parallel()

	srv, cookie := botBoard(t, errors.New("github: PUT x: nope"))

	resp := postUpdatePullRequestBranch(t, srv.URL, cookie, "github", "alrayyes/a", 5)
	_ = resp.Body.Close()
	require.GreaterOrEqual(t, resp.StatusCode, 400)

	assert.Nil(t, updateRequestOnBoard(t, srv, cookie))
}

var _ dashboard.BranchUpdater = (*botSource)(nil)
