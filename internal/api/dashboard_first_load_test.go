package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// slowSource answers after delay, like a forge fetch that takes a few
// seconds.
type slowSource struct {
	delay time.Duration
	prs   []dashboard.PullRequest
}

func (s *slowSource) Fetch(ctx context.Context) dashboard.Result {
	select {
	case <-time.After(s.delay):
	case <-ctx.Done():
	}

	return dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		PullRequests: s.prs,
	}
}

func (s *slowSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

// Right after a restart or a settings save the aggregator is new and its
// snapshot empty until its first fetch lands, a few seconds on a real forge.
// A read in that gap used to answer "no pull requests", and the page showed
// that and then refilled (#1194).
func TestDashboard_ReadBeforeTheFirstRefreshFinishes_WaitsForItInsteadOfAnsweringEmpty(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{&slowSource{
			delay: 300 * time.Millisecond,
			prs:   []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 1}},
		}}
	})
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+secretToken+`"}`, sessionCookie)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	resp := doJSON(t, http.MethodGet, srv.URL+"/api/dashboard", "", sessionCookie)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var snap dashboard.Snapshot
	require.NoError(t, readJSON(resp, &snap))

	assert.Len(t, snap.PullRequests, 1)
}
