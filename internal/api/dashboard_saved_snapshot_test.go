package api_test

import (
	"context"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// savedRows is a SnapshotCache that outlives a Service, the way the database
// outlives a restart.
type savedRows struct {
	mu   sync.Mutex
	rows []dashboard.CachedRepo
}

func (s *savedRows) LoadSnapshotRepos(context.Context, dashboard.Forge, string) ([]dashboard.CachedRepo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]dashboard.CachedRepo(nil), s.rows...), nil
}

func (s *savedRows) SaveSnapshotChanges(_ context.Context, _ dashboard.Forge, _ string, changed []dashboard.CachedRepo, removed []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var kept []dashboard.CachedRepo
	for _, r := range s.rows {
		if !slices.Contains(removed, r.Repo) && !slices.ContainsFunc(changed, func(c dashboard.CachedRepo) bool { return c.Repo == r.Repo }) {
			kept = append(kept, r)
		}
	}
	s.rows = slices.Concat(kept, changed)

	return nil
}

// oneRepoSource answers at once until hold is set, then blocks until release
// is closed, so a test can stand in the gap after a restart.
type oneRepoSource struct {
	hold    atomic.Bool
	release chan struct{}
}

func (s *oneRepoSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (s *oneRepoSource) Fetch(ctx context.Context) dashboard.Result {
	if s.hold.Load() {
		select {
		case <-s.release:
		case <-ctx.Done():
		}
	}

	return dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		Repos:  []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: "o/r"}},
		PullRequests: []dashboard.PullRequest{{
			Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 7, Title: "Saved change",
			UpdatedAt: time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC),
		}},
	}
}

func TestDashboard_AfterARestart_ShowsTheSavedSnapshotMarkedStaleNotALoadingState(t *testing.T) {
	t.Parallel()

	// An earlier run left its last snapshot behind.
	earlier := &oneRepoSource{release: make(chan struct{})}
	cache := &savedRows{}
	dashboard.NewAggregator([]dashboard.Source{earlier}, dashboard.WithSnapshotCache(cache)).Refresh(t.Context())

	// This run's forge is slow to answer.
	src := &oneRepoSource{release: make(chan struct{})}
	src.hold.Store(true)
	t.Cleanup(func() { close(src.release) })
	srv, _, _, _ := newTestServerWithSettingsStore(t, func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != firstRefreshToken {
			return nil
		}

		return []dashboard.Source{src}
	}, false, 50*time.Millisecond, func(d *api.Deps) { d.Service.SetSnapshotCache(cache) })
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	put := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+firstRefreshToken+`"}`, cookie)
	_ = put.Body.Close()
	require.Equal(t, http.StatusOK, put.StatusCode)

	body := fetchDashboardWith(t, srv.URL, cookie, "")
	prs, _ := body["pullRequests"].([]any)
	assert.Len(t, prs, 1, "the saved pull request is on the page before the first refresh ends")
	assert.Equal(t, true, body["firstRefreshDone"], "there is something to show, so no loading state")
	forges, _ := body["forges"].([]any)
	require.Len(t, forges, 1)
	forge, _ := forges[0].(map[string]any)
	assert.Equal(t, false, forge["reachable"])
	assert.NotNil(t, forge["staleSince"], "the saved rows say when they were fetched")
}
