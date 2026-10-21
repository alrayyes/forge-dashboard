package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestDashboard_RepoStatus_SerializesURLAndCanManageWebhooks is a
// regression test (#438) for a real gap: buildDashboardResponse built
// its repoStatus{} literal by naming only Forge/FullName/HasWebhook/
// Ignored, silently dropping dashboard.Repo's own URL and
// CanManageWebhooks even though both are documented in
// api/openapi.yaml's RepoStatus schema and read by the webhooks page.
// Every other test covering this page mocks /api/dashboard's response
// directly with hand-crafted JSON that already includes these fields,
// which is exactly why the real backend's gap went unnoticed — this one
// goes through the real handler and decodes the real JSON it writes.
func TestDashboard_RepoStatus_SerializesURLAndCanManageWebhooks(t *testing.T) {
	t.Parallel()

	repoJSON := repoStatusJSON(t, dashboard.Repo{
		Forge:             dashboard.ForgeGitHub,
		FullName:          "alrayyes/forge-dashboard",
		URL:               "https://github.com/alrayyes/forge-dashboard",
		CanManageWebhooks: true,
	})

	assert.Equal(t, "https://github.com/alrayyes/forge-dashboard", repoJSON["url"])
	assert.Equal(t, true, repoJSON["canManageWebhooks"])
	assert.NotContains(t, repoJSON, "webhookLockedByConnection", "absent unless the connection is the limit")
}

// The flag that tells the page the connection, not the user's role, is the
// limit has to survive dashboard.Repo -> repoStatus -> JSON.
func TestDashboard_RepoStatus_SerializesWebhookLockedByConnection(t *testing.T) {
	t.Parallel()

	repoJSON := repoStatusJSON(t, dashboard.Repo{
		Forge:                     dashboard.ForgeGitHub,
		FullName:                  "alrayyes/advisory-scan",
		WebhookLockedByConnection: true,
	})

	assert.Equal(t, false, repoJSON["canManageWebhooks"])
	assert.Equal(t, true, repoJSON["webhookLockedByConnection"])
}

// The flag that tells the page a saved token is what's missing has to
// survive dashboard.Repo -> repoStatus -> JSON, and stay off the wire when
// unset.
func TestDashboard_RepoStatus_SerializesWebhookNeedsToken(t *testing.T) {
	t.Parallel()

	repoJSON := repoStatusJSON(t, dashboard.Repo{
		Forge:             dashboard.ForgeForgejo,
		FullName:          "alrayyes/a",
		WebhookNeedsToken: true,
	})

	assert.Equal(t, false, repoJSON["canManageWebhooks"])
	assert.Equal(t, true, repoJSON["webhookNeedsToken"])

	plain := repoStatusJSON(t, dashboard.Repo{Forge: dashboard.ForgeForgejo, FullName: "alrayyes/b"})
	assert.NotContains(t, plain, "webhookNeedsToken")
}

// repoStatusJSON serves repo through the real handler and returns the JSON
// object /api/dashboard wrote for it.
func repoStatusJSON(t *testing.T, repo dashboard.Repo) map[string]any {
	t.Helper()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	source := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		repos:  []dashboard.Repo{repo},
	}
	buildSources := func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{source}
	}

	srv := newTestServerWithSources(t, buildSources)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/settings", strings.NewReader(`{"githubToken":"`+secretToken+`"}`))
	require.NoError(t, err)
	putReq.AddCookie(sessionCookie)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := testClient(t).Do(putReq)
	require.NoError(t, err)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	var repoJSON map[string]any
	require.Eventually(t, func() bool {
		snap := fetchDashboard(t, srv.URL, sessionCookie)
		repos, ok := snap["repos"].([]any)
		if !ok || len(repos) != 1 {
			return false
		}
		repoJSON = repos[0].(map[string]any)

		return true
	}, time.Second, 10*time.Millisecond, "the background refresh should have picked up the fixture repo")

	return repoJSON
}
