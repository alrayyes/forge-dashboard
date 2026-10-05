package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func updateRequestOf(t *testing.T, agg *dashboard.Aggregator) *dashboard.UpdateRequest {
	t.Helper()

	prs := agg.Get().PullRequests
	require.Len(t, prs, 1)

	return prs[0].UpdateRequest
}

func requestUpdate(agg *dashboard.Aggregator) {
	agg.RecordUpdateRequest(dashboard.ForgeGitHub, "o/r", 7)
}

func TestAggregator_RecordUpdateRequest(t *testing.T) {
	t.Parallel()

	t.Run("shows the request on the pull request at once, queued for five minutes", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, clock := botAggregator(t, src)

		requestUpdate(agg)

		got := updateRequestOf(t, agg)
		require.NotNil(t, got)
		assert.Equal(t, dashboard.UpdateQueued, got.Phase)
		assert.Equal(t, clock.now(), got.RequestedAt)
		assert.Equal(t, clock.now().Add(5*time.Minute), got.ExpiresAt)
	})

	t.Run("tells subscribers at once", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		ch, unsubscribe := agg.Subscribe()
		defer unsubscribe()

		requestUpdate(agg)

		select {
		case snap := <-ch:
			require.NotNil(t, snap.PullRequests[0].UpdateRequest)
		case <-time.After(time.Second):
			t.Fatal("subscriber was not told")
		}
	})

	t.Run("stays queued while the pull request is still behind", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		requestUpdate(agg)

		agg.Refresh(t.Context())

		assert.Equal(t, dashboard.UpdateQueued, updateRequestOf(t, agg).Phase)
	})

	t.Run("is cleared once a later fetch shows it no longer behind", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		requestUpdate(agg)
		src.set(botPR("b", false, dashboard.CIFailure))

		agg.Refresh(t.Context())

		assert.Nil(t, updateRequestOf(t, agg))
	})

	t.Run("an answer to a fetch that started before the request can't clear it", func(t *testing.T) {
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
		requestUpdate(agg)
		src.set(botPR("b", false, dashboard.CIFailure))
		close(gate)
		<-done

		require.NotNil(t, updateRequestOf(t, agg))
	})

	t.Run("queued past five minutes becomes expired and stays", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, clock := botAggregator(t, src)
		requestUpdate(agg)
		clock.advance(6 * time.Minute)

		agg.Refresh(t.Context())

		got := updateRequestOf(t, agg)
		require.NotNil(t, got)
		assert.Equal(t, dashboard.UpdateExpired, got.Phase)
	})

	t.Run("an expired request goes after an hour", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, clock := botAggregator(t, src)
		requestUpdate(agg)
		clock.advance(6 * time.Minute)
		agg.Refresh(t.Context())
		clock.advance(61 * time.Minute)

		agg.Refresh(t.Context())

		assert.Nil(t, updateRequestOf(t, agg))
	})

	t.Run("a new request replaces an expired one", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, clock := botAggregator(t, src)
		requestUpdate(agg)
		clock.advance(6 * time.Minute)
		agg.Refresh(t.Context())

		requestUpdate(agg)

		assert.Equal(t, dashboard.UpdateQueued, updateRequestOf(t, agg).Phase)
	})

	t.Run("is forgotten when the pull request is gone", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)
		requestUpdate(agg)
		src.set()

		agg.Refresh(t.Context())

		assert.Empty(t, agg.Get().PullRequests)
		src.set(botPR("a", true, dashboard.CIFailure))
		agg.Refresh(t.Context())
		assert.Nil(t, updateRequestOf(t, agg))
	})

	t.Run("a request for a pull request not on the board is ignored", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(botPR("a", true, dashboard.CIFailure))
		agg, _ := botAggregator(t, src)

		agg.RecordUpdateRequest(dashboard.ForgeGitHub, "o/r", 99)

		assert.Nil(t, updateRequestOf(t, agg))
	})
}
