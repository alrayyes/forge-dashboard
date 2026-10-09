package dashboard_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// botSource lists one pull request whose state a test sets, and can hold a
// fetch open to play a slow forge.
type botSource struct {
	mu        sync.Mutex
	prs       []dashboard.PullRequest
	reachable bool
	gate      chan struct{}
	started   chan struct{}
}

func newBotSource(prs ...dashboard.PullRequest) *botSource {
	return &botSource{prs: prs, reachable: true}
}

func (s *botSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (s *botSource) Fetch(context.Context) dashboard.Result {
	s.mu.Lock()
	gate, started := s.gate, s.started
	s.mu.Unlock()
	if started != nil {
		close(started)
	}
	if gate != nil {
		<-gate
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.reachable {
		return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: false}}
	}

	return dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: append([]dashboard.PullRequest(nil), s.prs...),
	}
}

func (s *botSource) FetchRepo(ctx context.Context, _, _, _ string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	return s.Fetch(ctx).PullRequests, nil, nil
}

func (s *botSource) set(prs ...dashboard.PullRequest) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prs = prs
}

func botPR(head string, behind bool, ci dashboard.CIStatus) dashboard.PullRequest {
	return dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 7,
		HeadSHA: head, Behind: behind, CI: ci,
	}
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func botAggregator(t *testing.T, src *botSource) (*dashboard.Aggregator, *fakeClock) {
	t.Helper()

	clock := &fakeClock{t: time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)}
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.now))
	agg.Refresh(t.Context())

	return agg, clock
}

func request(agg *dashboard.Aggregator) {
	agg.RecordBotRequest(dashboard.ForgeGitHub, "o/r", 7, dashboard.BotDependabot, dashboard.BotRebase)
}

func botRequestOf(t *testing.T, agg *dashboard.Aggregator) *dashboard.BotRequest {
	t.Helper()

	prs := agg.Get().PullRequests
	require.Len(t, prs, 1)

	return prs[0].BotRequest
}

func TestAggregator_RecordBotRequest(t *testing.T) {
	t.Parallel()

	t.Run("shows the request on the pull request at once, queued for ten minutes", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, clock := botAggregator(t, src)

		request(agg)

		got := botRequestOf(t, agg)
		require.NotNil(t, got)
		assert.Equal(t, dashboard.BotQueued, got.Phase)
		assert.Equal(t, dashboard.BotDependabot, got.Bot)
		assert.Equal(t, dashboard.BotRebase, got.Action)
		assert.Equal(t, clock.now(), got.RequestedAt)
		assert.Equal(t, clock.now().Add(10*time.Minute), got.ExpiresAt)
	})

	t.Run("tells subscribers at once", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		ch, unsubscribe := agg.Subscribe()
		defer unsubscribe()

		request(agg)

		select {
		case snap := <-ch:
			require.Len(t, snap.PullRequests, 1)
			assert.NotNil(t, snap.PullRequests[0].BotRequest)
		case <-time.After(time.Second):
			t.Fatal("no snapshot pushed after RecordBotRequest")
		}
	})

	t.Run("stays queued across a refresh that shows nothing changed", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		request(agg)

		agg.Refresh(t.Context())

		assert.Equal(t, dashboard.BotQueued, botRequestOf(t, agg).Phase)
	})

	t.Run("an answer to a fetch that started before the request can't land it", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		src.mu.Lock()
		src.gate, src.started = make(chan struct{}), make(chan struct{})
		gate, started := src.gate, src.started
		src.mu.Unlock()

		done := make(chan struct{})
		go func() { agg.Refresh(t.Context()); close(done) }()
		<-started
		request(agg)
		src.set(botPR("b", false, dashboard.CIFailure))
		close(gate)
		<-done

		assert.Equal(t, dashboard.BotQueued, botRequestOf(t, agg).Phase)
	})

	t.Run("a changed head means the bot pushed: rebasing for two minutes", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, clock := botAggregator(t, src)
		request(agg)
		clock.advance(time.Minute)
		src.set(botPR("b", true, dashboard.CIFailure))

		agg.Refresh(t.Context())

		got := botRequestOf(t, agg)
		require.NotNil(t, got)
		assert.Equal(t, dashboard.BotRebasing, got.Phase)
		assert.Equal(t, clock.now().Add(2*time.Minute), got.ExpiresAt)
	})

	t.Run("no longer behind counts as landed even when the head is the same", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		request(agg)
		src.set(botPR("", false, dashboard.CIFailure))

		agg.Refresh(t.Context())

		assert.Equal(t, dashboard.BotRebasing, botRequestOf(t, agg).Phase)
	})

	t.Run("landed with CI already pending is finished, no request left", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		request(agg)
		src.set(botPR("b", false, dashboard.CIPending))

		agg.Refresh(t.Context())

		assert.Nil(t, botRequestOf(t, agg))
	})

	t.Run("rebasing ends when CI shows pending", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		request(agg)
		src.set(botPR("b", false, dashboard.CIFailure))
		agg.Refresh(t.Context())
		require.Equal(t, dashboard.BotRebasing, botRequestOf(t, agg).Phase)
		src.set(botPR("b", false, dashboard.CIPending))

		agg.Refresh(t.Context())

		assert.Nil(t, botRequestOf(t, agg))
	})

	t.Run("rebasing gives up after two minutes for a repo whose CI never restarts", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, clock := botAggregator(t, src)
		request(agg)
		src.set(botPR("b", false, dashboard.CIFailure))
		agg.Refresh(t.Context())
		clock.advance(2*time.Minute + time.Second)

		agg.Refresh(t.Context())

		assert.Nil(t, botRequestOf(t, agg))
	})

	t.Run("queued past ten minutes becomes expired and stays", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, clock := botAggregator(t, src)
		request(agg)
		clock.advance(10*time.Minute + time.Second)

		agg.Refresh(t.Context())
		assert.Equal(t, dashboard.BotExpired, botRequestOf(t, agg).Phase)

		clock.advance(30 * time.Minute)
		agg.Refresh(t.Context())
		assert.Equal(t, dashboard.BotExpired, botRequestOf(t, agg).Phase)
	})

	t.Run("an expired request goes after an hour", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, clock := botAggregator(t, src)
		request(agg)
		clock.advance(11 * time.Minute)
		agg.Refresh(t.Context())
		clock.advance(61 * time.Minute)

		agg.Refresh(t.Context())

		assert.Nil(t, botRequestOf(t, agg))
	})

	t.Run("a new request replaces an expired one", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, clock := botAggregator(t, src)
		request(agg)
		clock.advance(11 * time.Minute)
		agg.Refresh(t.Context())

		request(agg)

		got := botRequestOf(t, agg)
		assert.Equal(t, dashboard.BotQueued, got.Phase)
		assert.Equal(t, clock.now(), got.RequestedAt)
	})

	t.Run("is forgotten when the pull request is gone", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		request(agg)
		src.set()
		agg.Refresh(t.Context())
		src.set(botPR("a", true, dashboard.CIFailure))

		agg.Refresh(t.Context())

		assert.Nil(t, botRequestOf(t, agg))
	})

	t.Run("a failed fetch of the forge says nothing, so the request stays", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		request(agg)
		src.mu.Lock()
		src.reachable = false
		src.mu.Unlock()
		agg.Refresh(t.Context())
		src.mu.Lock()
		src.reachable = true
		src.mu.Unlock()

		agg.Refresh(t.Context())

		assert.Equal(t, dashboard.BotQueued, botRequestOf(t, agg).Phase)
	})

	t.Run("a scoped refresh of the repo moves it along too", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		request(agg)
		src.set(botPR("b", false, dashboard.CIFailure))

		require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "o", "r", "o/r"))

		assert.Equal(t, dashboard.BotRebasing, botRequestOf(t, agg).Phase)
	})

	t.Run("a request for a pull request not on the board is ignored", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)

		agg.RecordBotRequest(dashboard.ForgeGitHub, "o/r", 99, dashboard.BotDependabot, dashboard.BotRebase)

		assert.Nil(t, botRequestOf(t, agg))
	})
}
