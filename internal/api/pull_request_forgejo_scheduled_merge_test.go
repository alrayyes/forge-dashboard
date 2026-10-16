package api_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// scheduleCancelSource is a Forgejo source that can cancel a merge scheduled on the
// forge and records the calls (#1571).
type scheduleCancelSource struct {
	fakeConfiguredSource

	mu    sync.Mutex
	calls []int
	err   error
}

func (s *scheduleCancelSource) DisableAutoMerge(_ context.Context, _, _ string, number int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, number)

	return s.err
}

func (s *scheduleCancelSource) cancelled() []int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]int(nil), s.calls...)
}

func scheduledBoard(t *testing.T, src *scheduleCancelSource, prs ...dashboard.PullRequest) (*httptest.Server, *http.Cookie) {
	t.Helper()

	src.health = dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true, RepoCount: 1}
	src.prs = prs
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.ForgejoToken == "" {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"forgejoUrl":"https://f.example","forgejoToken":"fj_secret"}`, cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Eventually(t, func() bool {
		got, _ := fetchDashboardWith(t, srv.URL, cookie, "")["pullRequests"].([]any)

		return len(got) == len(prs)
	}, time.Second, 10*time.Millisecond)

	return srv, cookie
}

func scheduledPR() dashboard.PullRequest {
	on := true

	return forgejoPR(func(p *dashboard.PullRequest) {
		p.AutoMergeEnabled = &on
		p.AutoMergeHeldBy = dashboard.AutoMergeHeldByForge
	})
}

func TestForgejoScheduledMerge_ShowsAsAutoMergingAndOffersCancel(t *testing.T) {
	t.Parallel()
	srv, cookie := scheduledBoard(t, &scheduleCancelSource{}, scheduledPR())

	pr := boardPR(t, srv, cookie)

	assert.Equal(t, true, pr["autoMergeEnabled"])
	assert.Contains(t, allowedActionNames(t, pr), "cancel_auto_merge")
	assert.NotContains(t, allowedActionNames(t, pr), "auto_merge")
}

func TestForgejoScheduledMerge_Cancel_CancelsOnTheForge(t *testing.T) {
	t.Parallel()
	src := &scheduleCancelSource{}
	srv, cookie := scheduledBoard(t, src, scheduledPR())

	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge/cancel", "forgejo")
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, []int{armedNumber}, src.cancelled())
}

func TestForgejoScheduledMerge_Cancel_AlsoDropsTheAppIntent(t *testing.T) {
	t.Parallel()
	src := &scheduleCancelSource{}
	srv, cookie := scheduledBoard(t, src, forgejoPR(nil))
	armed := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	_ = armed.Body.Close()

	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge/cancel", "forgejo")
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, []int{armedNumber}, src.cancelled())
	assert.NotEqual(t, true, boardPR(t, srv, cookie)["autoMergeEnabled"])
}

func TestForgejoScheduledMerge_Cancel_ForgeFailureKeepsTheIntent(t *testing.T) {
	t.Parallel()
	src := &scheduleCancelSource{err: errors.New("forge down")}
	srv, cookie := scheduledBoard(t, src, forgejoPR(nil))
	armed := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	_ = armed.Body.Close()

	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge/cancel", "forgejo")
	_ = resp.Body.Close()

	assert.GreaterOrEqual(t, resp.StatusCode, 400)
	assert.Equal(t, true, boardPR(t, srv, cookie)["autoMergeEnabled"], "a cancel that didn't happen leaves the pull request armed")
}

func TestForgejoAutoMerge_HeldBy(t *testing.T) {
	t.Parallel()
	cases := map[string]struct {
		pr     dashboard.PullRequest
		arm    bool
		heldBy any
	}{
		"scheduled on the forge": {scheduledPR(), false, "forge"},
		"armed in the app":       {forgejoPR(nil), true, "dashboard"},
		"neither":                {forgejoPR(nil), false, nil},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			srv, cookie := scheduledBoard(t, &scheduleCancelSource{}, tc.pr)
			if tc.arm {
				armed := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
				_ = armed.Body.Close()
			}

			pr := boardPR(t, srv, cookie)

			assert.Equal(t, tc.heldBy, pr["autoMergeHeldBy"])
			if tc.heldBy == nil {
				assert.NotContains(t, pr, "autoMergeHeldBy")
			}
		})
	}
}
