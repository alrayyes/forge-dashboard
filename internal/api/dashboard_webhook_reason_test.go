package api_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// hookSource is a forge that can create hooks, and answers every create with
// ensureErr.
type hookSource struct {
	fakeConfiguredSource

	ensureErr error
}

func (s *hookSource) EnsureWebhook(context.Context, string, string, string, string) error {
	return s.ensureErr
}

// webhookDashboard serves one GitHub source behind the real hook pass and
// returns the dashboard body once it holds wantRepos repos and ready says it
// has learned what it should.
func webhookDashboard(t *testing.T, src *hookSource, origin string, ready func(map[string]any) bool) map[string]any {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	build := func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token {
			return nil
		}

		return []dashboard.Source{src}
	}
	srv, service, _, store := newTestServerWithSettingsStore(t, build, false, 0, func(d *api.Deps) { d.PublicOrigin = origin })
	service.SetWebhookUpgrade(store, origin)
	cookie, _, _ := registerViaRealCeremony(t, srv)

	req, err := http.NewRequest(http.MethodPut, srv.URL+"/api/v1/settings", strings.NewReader(`{"githubToken":"`+token+`"}`))
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var body map[string]any
	require.Eventually(t, func() bool {
		body = fetchDashboard(t, srv.URL, cookie)
		repos, _ := body["repos"].([]any)

		return len(repos) == len(src.repos) && ready(body)
	}, pollBudget, 10*time.Millisecond)

	return body
}

func firstRepo(body map[string]any) map[string]any {
	return body["repos"].([]any)[0].(map[string]any)
}

func githubSource(health dashboard.ForgeHealth, ensureErr error, repos ...dashboard.Repo) *hookSource {
	health.Forge = dashboard.ForgeGitHub

	return &hookSource{fakeConfiguredSource: fakeConfiguredSource{health: health, repos: repos}, ensureErr: ensureErr}
}

func always(map[string]any) bool { return true }

const goodOrigin = "https://dash.example"

func TestDashboard_WebhookReason_RepoTheTokenCannotAdminister_IsNoPermission(t *testing.T) {
	t.Parallel()

	src := githubSource(dashboard.ForgeHealth{Reachable: true}, nil, dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: "o/locked"})

	assert.Equal(t, "no_permission", firstRepo(webhookDashboard(t, src, goodOrigin, always))["webhookReason"])
}

func TestDashboard_WebhookReason_RepoWithAHook_HasNone(t *testing.T) {
	t.Parallel()

	src := githubSource(dashboard.ForgeHealth{Reachable: true}, nil, dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: "o/ok", HasWebhook: true})

	assert.NotContains(t, firstRepo(webhookDashboard(t, src, goodOrigin, always)), "webhookReason")
}

func TestDashboard_WebhookReason_ForgeThatIsDown_IsUnavailable(t *testing.T) {
	t.Parallel()

	src := githubSource(dashboard.ForgeHealth{Reachable: false}, nil, dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: "o/bare", CanManageWebhooks: true})

	assert.Equal(t, "forge_unavailable", firstRepo(webhookDashboard(t, src, goodOrigin, always))["webhookReason"])
}

func TestDashboard_WebhookReason_RateLimitedCreate_IsUnavailable(t *testing.T) {
	t.Parallel()

	src := githubSource(dashboard.ForgeHealth{Reachable: true}, &dashboard.ClientError{Kind: dashboard.ForgeErrorRateLimited, Err: errors.New("slow down")},
		dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: "o/bare", CanManageWebhooks: true})

	body := webhookDashboard(t, src, goodOrigin, func(b map[string]any) bool { return firstRepo(b)["webhookReason"] != nil })

	assert.Equal(t, "forge_unavailable", firstRepo(body)["webhookReason"])
}

func TestDashboard_WebhookReason_RefusedCreate_CarriesTheForgesReasonAndTheNextAttempt(t *testing.T) {
	t.Parallel()

	src := githubSource(dashboard.ForgeHealth{Reachable: true}, &dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: errors.New("403 forbidden")},
		dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: "o/bare", CanManageWebhooks: true})

	repo := firstRepo(webhookDashboard(t, src, goodOrigin, func(b map[string]any) bool { return firstRepo(b)["webhookReason"] != nil }))

	assert.Equal(t, "forge_refused", repo["webhookReason"])
	assert.NotEmpty(t, repo["webhookReasonDetail"])
	next, err := time.Parse(time.RFC3339, repo["webhookNextAttemptAt"].(string))
	require.NoError(t, err)
	assert.True(t, next.After(time.Now()))
}

func TestDashboard_WebhookOriginProblem(t *testing.T) {
	t.Parallel()

	creatable := dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: "o/bare", CanManageWebhooks: true}
	locked := dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: "o/locked"}

	t.Run("a localhost origin is named once on the dashboard", func(t *testing.T) {
		t.Parallel()

		body := webhookDashboard(t, githubSource(dashboard.ForgeHealth{Reachable: true}, nil, creatable), "https://localhost", always)

		assert.Contains(t, body["webhookOriginProblem"], "localhost")
	})

	t.Run("a reachable origin has no problem", func(t *testing.T) {
		t.Parallel()

		body := webhookDashboard(t, githubSource(dashboard.ForgeHealth{Reachable: true}, nil, creatable), goodOrigin, always)

		assert.NotContains(t, body, "webhookOriginProblem")
	})

	t.Run("nothing to create means nothing to explain", func(t *testing.T) {
		t.Parallel()

		body := webhookDashboard(t, githubSource(dashboard.ForgeHealth{Reachable: true}, nil, locked), "http://localhost", always)

		assert.NotContains(t, body, "webhookOriginProblem")
	})
}
