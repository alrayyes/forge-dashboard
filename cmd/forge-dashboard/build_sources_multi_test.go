package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/alrayyes/forge-dashboard/internal/githubstatus"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// multiServer is a GitHub API stand-in for two installations that counts the
// calls the shared caches and the webhook check make.
type multiServer struct {
	url         string
	alertReads  atomic.Int32
	bodyReads   atomic.Int32
	hookReads   atomic.Int32
	statusReads atomic.Int32
}

func newMultiServer(t *testing.T) *multiServer {
	t.Helper()
	m := &multiServer{}
	mux := http.NewServeMux()
	for _, id := range []string{"42", "43"} {
		mux.HandleFunc("/app/installations/"+id+"/access_tokens", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"token":"token-` + id + `","expires_at":"` + time.Now().Add(time.Hour).UTC().Format(time.RFC3339) + `"}`))
		})
	}
	mux.HandleFunc("/repos/octo/repo/dependabot/alerts", func(w http.ResponseWriter, _ *http.Request) {
		m.alertReads.Add(1)
		_, _ = w.Write([]byte(`[{"number":1,"state":"open","created_at":"2026-10-21T14:12:00Z","html_url":"https://github.com/octo/repo/security/dependabot/1","dependency":{"package":{"name":"left-pad"}},"security_advisory":{"severity":"high","summary":"s"}}]`))
	})
	mux.HandleFunc("/repos/octo/repo/hooks", func(w http.ResponseWriter, _ *http.Request) {
		m.hookReads.Add(1)
		_, _ = w.Write([]byte(`[]`))
	})
	mux.HandleFunc("/installation/repositories", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"total_count":0,"repositories":[]}`))
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"rateLimit":{"limit":5000,"remaining":5000,"resetAt":"2026-09-14T16:00:00Z"},"viewer":{"repositories":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		m.bodyReads.Add(1)
		_, _ = w.Write([]byte(`{"body_html":"<a href=\"https://github.com/user-attachments/assets/a\"><img src=\"https://private-user-images.githubusercontent.com/a.png\"></a>"}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	m.url = srv.URL

	return m
}

// members builds the two-installation source through buildSources and returns
// the clients behind it. Not parallel: it points the package's GitHub API and
// status page addresses at local servers.
func (m *multiServer) members(t *testing.T, counters *apistats.Counters, c settings.Credentials) []github.Member {
	t.Helper()

	return m.builder(t, counters, c)()
}

// builder is members for a caller that builds the source again, as every
// request does, from the one buildSources closure.
func (m *multiServer) builder(t *testing.T, counters *apistats.Counters, c settings.Credentials) func() []github.Member {
	t.Helper()
	githubAPIBaseURL = m.url
	t.Cleanup(func() { githubAPIBaseURL = "" })
	status := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		m.statusReads.Add(1)
		_, _ = w.Write([]byte(`{"status":{"indicator":"minor"},"components":[{"name":"Actions","status":"degraded_performance"}],"incidents":[{"name":"Slow runs","components":[{"name":"Actions"}]}]}`))
	}))
	t.Cleanup(status.Close)
	githubStatusURL = status.URL
	t.Cleanup(func() { githubStatusURL = githubstatus.BaseURL })

	c.GitHubAppInstallationID = 42
	c.GitHubAppInstallationIDs = []int64{42, 43}
	build := buildSources(newTestAuthStore(t), nil, 1, testGitHubAppPrivateKeyPEM, counters, nil)

	return func() []github.Member {
		sources := build(c)
		require.Len(t, sources, 1)
		multi, ok := sources[0].(*github.Multi)
		require.True(t, ok, "two installations make a composite source")
		got := multi.Members()
		require.Len(t, got, 2)

		return got
	}
}

func TestBuildSources_EveryInstallationAsksTheSharedStatusPage(t *testing.T) {
	m := newMultiServer(t)
	members := m.members(t, nil, settings.Credentials{})

	for _, member := range members {
		src, ok := member.Source.(dashboard.ProviderStatusSource)
		require.True(t, ok)
		got := src.ProviderStatus(t.Context())
		require.NotNil(t, got, "installation %d has a status checker", member.ID)
		assert.Equal(t, []string{"Slow runs"}, got.Incidents)
	}

	assert.EqualValues(t, 1, m.statusReads.Load(), "one status page reader across the installations")
}

func TestBuildSources_EveryInstallationKeepsItsAdvisoryAndBodyCacheAcrossRequests(t *testing.T) {
	m := newMultiServer(t)
	build := m.builder(t, nil, settings.Credentials{})
	item := dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}

	// Each request builds fresh clients. Entries are filed under the
	// installation's own credential, so two installations read once each and
	// a second request reads nothing.
	for range 2 {
		for _, member := range build() {
			lister, ok := member.Source.(dashboard.AdvisoryLister)
			require.True(t, ok)
			got, err := lister.ListAdvisories(t.Context(), "octo", "repo")
			require.NoError(t, err)
			require.Len(t, got.Advisories, 1)

			resolver, ok := member.Source.(dashboard.ImageLinkResolver)
			require.True(t, ok)
			_, err = resolver.SignedImageURL(t.Context(), "octo", "repo", item, "https://github.com/user-attachments/assets/a")
			require.NoError(t, err)
		}
	}

	assert.EqualValues(t, 2, m.alertReads.Load(), "one read per installation, not per request")
	assert.EqualValues(t, 2, m.bodyReads.Load(), "one rendered body per installation, not per request")
}

func TestBuildSources_EveryInstallationGetsItsOwnWiring(t *testing.T) {
	m := newMultiServer(t)
	counters := apistats.New()
	members := m.members(t, counters, settings.Credentials{GitHubToken: "pat-value", WebhookToken: "hook"})

	for _, member := range members {
		blocker, ok := member.Source.(dashboard.DependabotCommandBlocker)
		require.True(t, ok)
		assert.Empty(t, blocker.DependabotCommandsBlockedReason(), "installation %d posts Dependabot commands with the saved token", member.ID)

		checker, ok := member.Source.(dashboard.WebhookChecker)
		require.True(t, ok)
		_, err := checker.HasWebhook(t.Context(), "octo", "repo")
		require.NoError(t, err)

		member.Source.Fetch(t.Context())
	}

	assert.EqualValues(t, 2, m.hookReads.Load(), "each installation has the webhook path")
	counted := countedCredentials(counters, "github")
	assert.Contains(t, counted, apistats.AppCredential(42))
	assert.Contains(t, counted, apistats.AppCredential(43))
}
