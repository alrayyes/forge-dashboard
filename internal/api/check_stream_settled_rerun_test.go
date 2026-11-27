package api_test

import (
	"bufio"
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// settledRerunSource is a Forgejo source whose one failed pull request can have its job
// rerun: a newer status and no webhook.
type settledRerunSource struct {
	rerun atomic.Bool
}

func (s *settledRerunSource) Forge() dashboard.Forge { return dashboard.ForgeForgejo }

func (s *settledRerunSource) pullRequest() dashboard.PullRequest {
	pr := dashboard.PullRequest{
		Forge: dashboard.ForgeForgejo, Repo: "alrayyes/tempus-fugit", Number: 7,
		CI: dashboard.CIFailure, Checks: dashboard.CheckCounts{Failed: 1}, HeadSHA: "cafef00d", LatestStatusID: 1,
	}
	if s.rerun.Load() {
		pr.CI, pr.Checks, pr.LatestStatusID = dashboard.CIPending, dashboard.CheckCounts{Waiting: 1}, 2
	}

	return pr
}

func (s *settledRerunSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		PullRequests: []dashboard.PullRequest{s.pullRequest()},
	}
}

func (s *settledRerunSource) FetchRepo(_ context.Context, _, _, _ string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	return []dashboard.PullRequest{s.pullRequest()}, nil, nil
}

func (s *settledRerunSource) LatestStatusID(_ context.Context, _, _, _ string) (int64, error) {
	return s.pullRequest().LatestStatusID, nil
}

func (s *settledRerunSource) ListChecks(_ context.Context, _, _ string, _ int) ([]dashboard.Check, error) {
	state := dashboard.CheckFailure
	if s.rerun.Load() {
		state = dashboard.CheckRunning
	}

	return []dashboard.Check{{Name: "test", State: state, RunID: 11, RunAttempt: 1}}, nil
}

// firstStatus is the status of the first check of a listing's first run event.
func firstStatus(t *testing.T, listing []map[string]any) any {
	t.Helper()
	checks, ok := listing[0]["checks"].([]any)
	require.True(t, ok)
	require.NotEmpty(t, checks)
	check, ok := checks[0].(map[string]any)
	require.True(t, ok)

	return check["status"]
}

// The open checks dialog gets a new job list when its row changes, so it moves
// once the CI poll has noticed the rerun (#5076).
func TestCheckStream_ARerunOfAFailedJobSendsTheOpenDialogItsNewState(t *testing.T) {
	t.Parallel()

	source := &settledRerunSource{}
	srvURL, cookie, _ := newTestServerWithDrain(t, source, func(_ time.Duration, f func()) func() bool {
		return time.AfterFunc(time.Millisecond, f).Stop
	}, &api.Drain{}, func(s *dashboard.Service) { s.SetCIPollInterval(50 * time.Millisecond) })

	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/v1/dashboard/stream?sid="+watchedStreamID, nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	events := make(chan sseEvent, 16)
	go readNamedEvents(bufio.NewReader(resp.Body), events)
	load, err := http.NewRequest(http.MethodGet, srvURL+"/api/v1/dashboard", nil)
	require.NoError(t, err)
	load.AddCookie(cookie)
	loaded, err := testClient(t).Do(load)
	require.NoError(t, err)
	require.NoError(t, loaded.Body.Close())
	feed := &checkFeed{srvURL: srvURL, cookie: cookie, events: events}

	feed.watch(t, `{"streamId":"`+watchedStreamID+`","subjects":[{"kind":"pull_request","forge":"forgejo","fullName":"alrayyes/tempus-fugit","number":7}]}`)
	require.Equal(t, "completed", firstStatus(t, feed.nextListing(t)))

	source.rerun.Store(true)

	assert.Equal(t, "in_progress", firstStatus(t, feed.nextListing(t)))
}
