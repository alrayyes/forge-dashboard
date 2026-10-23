package github_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const appLogo = "https://repository-images.githubusercontent.com/1/logo"

// appIncrementalServer is a GitHub App installation that tells the REST
// listing, the probe batch and the per-repo batch apart and counts each.
type appIncrementalServer struct {
	t   *testing.T
	srv *httptest.Server

	mu         sync.Mutex
	order      []string
	pushedAt   map[string]string
	listings   int
	probes     int
	probeQuery string
	batches    [][]string
}

func newAppIncrementalServer(t *testing.T, repos ...string) *appIncrementalServer {
	t.Helper()

	s := &appIncrementalServer{t: t, order: repos, pushedAt: map[string]string{}}
	for _, r := range repos {
		s.pushedAt[r] = "2026-01-01T00:00:00Z"
	}
	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID), func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"token": "installation-token-value", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("/installation/repositories", s.listing)
	mux.HandleFunc("/graphql", s.graphql)
	mux.HandleFunc("/repos/alrayyes/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{{
			"id": 1, "events": []string{"pull_request", "check_run"},
			"config": map[string]any{"url": "https://dashboard.example" + incrementalHookPath},
		}})
	})
	s.srv = httptest.NewServer(mux)
	t.Cleanup(s.srv.Close)

	return s
}

func (s *appIncrementalServer) listing(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listings++
	var repos []map[string]any
	for _, name := range s.order {
		repos = append(repos, map[string]any{
			"name": name, "full_name": "alrayyes/" + name, "html_url": "https://github.com/alrayyes/" + name,
			"fork": false, "archived": false, "owner": map[string]any{"login": "alrayyes"},
		})
	}
	writeJSON(s.t, w, map[string]any{"total_count": len(repos), "repositories": repos})
}

func (s *appIncrementalServer) graphql(w http.ResponseWriter, r *http.Request) {
	body := readGraphQLRequest(s.t, r)
	s.mu.Lock()
	defer s.mu.Unlock()

	var names []string
	data := map[string]any{}
	for i := 0; ; i++ {
		name, ok := body.Variables["name"+itoa(i)].(string)
		if !ok {
			break
		}
		names = append(names, name)
		alias := "r" + itoa(i)
		if strings.Contains(body.Query, "pushedAt") {
			data[alias] = map[string]any{
				"pushedAt": s.pushedAt[name], "updatedAt": s.pushedAt[name],
				"openPRs":    map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
				"openIssues": map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
				// A probe that doesn't carry the logo loses it for every App repo.
				"usesCustomOpenGraphImage": name == "a", "openGraphImageUrl": appLogo,
			}

			continue
		}
		data[alias] = map[string]any{
			"usesCustomOpenGraphImage": name == "a", "openGraphImageUrl": appLogo,
			"pullRequests": map[string]any{"nodes": []map[string]any{}},
			"issuesTotal":  map[string]any{"totalCount": 0},
			"issues":       map[string]any{"nodes": []map[string]any{}},
		}
	}
	if strings.Contains(body.Query, "pushedAt") {
		s.probes++
		s.probeQuery = body.Query
	} else {
		s.batches = append(s.batches, names)
	}
	writeJSON(s.t, w, map[string]any{"data": data})
}

func (s *appIncrementalServer) client() *github.Client {
	c, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, s.srv.URL)
	require.NoError(s.t, err)
	c.SetWebhookPath(incrementalHookPath)

	return c
}

func (s *appIncrementalServer) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listings, s.probes, s.batches = 0, 0, nil
}

func repoRow(t *testing.T, repos []dashboard.Repo, fullName string) dashboard.Repo {
	t.Helper()
	for _, r := range repos {
		if r.FullName == fullName {
			return r
		}
	}
	require.Failf(t, "repo row missing", "%s", fullName)

	return dashboard.Repo{}
}

func TestAppFetch_FullPass_ListsOnceProbesAndKeepsLogosAndHookState(t *testing.T) {
	t.Parallel()

	s := newAppIncrementalServer(t, "a", "b")
	result := s.client().Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	assert.Equal(t, 1, s.listings, "the probe's installation listing is reused, not repeated")
	assert.Equal(t, 1, s.probes)
	assert.Contains(t, s.probeQuery, "usesCustomOpenGraphImage", "the probe asks for the logo")
	require.Len(t, s.batches, 1)
	assert.ElementsMatch(t, []string{"a", "b"}, s.batches[0])
	a := repoRow(t, result.Repos, "alrayyes/a")
	assert.Equal(t, appLogo, a.LogoURL)
	assert.True(t, a.HasWebhook)
	assert.True(t, a.CanManageWebhooks)
	assert.Empty(t, repoRow(t, result.Repos, "alrayyes/b").LogoURL)
}

func TestAppFetch_Incremental_NothingChanged_SkipsEveryRepoAndKeepsLogos(t *testing.T) {
	t.Parallel()

	s := newAppIncrementalServer(t, "a", "b")
	client := s.client()
	client.Fetch(t.Context())
	s.reset()

	result := client.Fetch(dashboard.WithIncremental(t.Context()))

	assert.ElementsMatch(t, []string{"alrayyes/a", "alrayyes/b"}, result.Unchanged)
	assert.Equal(t, 1, s.listings)
	assert.Equal(t, 1, s.probes)
	assert.Empty(t, s.batches, "no per-repo query")
	a := repoRow(t, result.Repos, "alrayyes/a")
	assert.Equal(t, appLogo, a.LogoURL)
	assert.True(t, a.CanManageWebhooks)
}

func TestAppFetch_Incremental_OneChanged_FetchesOnlyThatRepo(t *testing.T) {
	t.Parallel()

	s := newAppIncrementalServer(t, "a", "b", "c")
	client := s.client()
	client.Fetch(t.Context())
	s.reset()
	s.pushedAt["b"] = "2026-02-01T00:00:00Z"

	result := client.Fetch(dashboard.WithIncremental(t.Context()))

	require.Len(t, s.batches, 1)
	assert.Equal(t, []string{"b"}, s.batches[0])
	assert.ElementsMatch(t, []string{"alrayyes/a", "alrayyes/c"}, result.Unchanged)
	assert.Equal(t, 1, s.listings, "candidates come from the probe's listing")
	assert.Len(t, result.Repos, 3)
	assert.Equal(t, appLogo, repoRow(t, result.Repos, "alrayyes/a").LogoURL)
}
