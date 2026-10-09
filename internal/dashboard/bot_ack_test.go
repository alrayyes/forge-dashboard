package dashboard_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ackSource is a botSource whose forge can say whether Dependabot reacted to
// a command comment, and records what it was asked (#1082).
type ackSource struct {
	*botSource

	ackMu sync.Mutex
	ack   dashboard.CommandAck
	err   error
	calls []ackCall
}

type ackCall struct {
	owner, name string
	number      int
	command     string
	since       time.Time
}

func (s *ackSource) DependabotAck(_ context.Context, owner, name string, number int, command string, since time.Time) (dashboard.CommandAck, error) {
	s.ackMu.Lock()
	defer s.ackMu.Unlock()
	s.calls = append(s.calls, ackCall{owner, name, number, command, since})

	return s.ack, s.err
}

func (s *ackSource) setAck(ack dashboard.CommandAck, err error) {
	s.ackMu.Lock()
	defer s.ackMu.Unlock()
	s.ack, s.err = ack, err
}

func (s *ackSource) callCount() int {
	s.ackMu.Lock()
	defer s.ackMu.Unlock()

	return len(s.calls)
}

func (s *ackSource) firstCall() ackCall {
	s.ackMu.Lock()
	defer s.ackMu.Unlock()

	return s.calls[0]
}

func ackAggregator(t *testing.T) (*dashboard.Aggregator, *ackSource, *fakeClock) {
	t.Helper()

	src := &ackSource{botSource: newBotSource(botPR("a", true, dashboard.CIFailure))}
	clock := &fakeClock{t: time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)}
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.now))
	agg.Refresh(t.Context())

	return agg, src, clock
}

func TestAggregator_DependabotAcknowledgement(t *testing.T) {
	t.Parallel()

	const commentURL = "https://github.com/o/r/pull/7#issuecomment-42"

	t.Run("asks the forge about the rebase comment posted since the request", func(t *testing.T) {
		t.Parallel()
		agg, src, clock := ackAggregator(t)
		request(agg)
		requestedAt := clock.now()
		clock.advance(time.Minute)

		agg.Refresh(t.Context())

		require.Equal(t, 1, src.callCount())
		assert.Equal(t, ackCall{"o", "r", 7, dashboard.DependabotRebaseComment, requestedAt}, src.firstCall())
	})

	t.Run("a thumbs-up marks the request acknowledged and waits ten minutes from it", func(t *testing.T) {
		t.Parallel()
		agg, src, clock := ackAggregator(t)
		request(agg)
		clock.advance(45 * time.Second)
		src.setAck(dashboard.CommandAck{CommentURL: commentURL, Acknowledged: true}, nil)

		agg.Refresh(t.Context())

		got := botRequestOf(t, agg)
		require.NotNil(t, got)
		assert.Equal(t, dashboard.BotQueued, got.Phase)
		require.NotNil(t, got.AcknowledgedAt)
		assert.Equal(t, clock.now(), *got.AcknowledgedAt)
		assert.Equal(t, commentURL, got.CommentURL)
		assert.Equal(t, clock.now().Add(10*time.Minute), got.ExpiresAt)
	})

	t.Run("a comment with no reaction yet only gets its link recorded", func(t *testing.T) {
		t.Parallel()
		agg, src, _ := ackAggregator(t)
		request(agg)
		src.setAck(dashboard.CommandAck{CommentURL: commentURL}, nil)

		agg.Refresh(t.Context())

		got := botRequestOf(t, agg)
		assert.Nil(t, got.AcknowledgedAt)
		assert.Equal(t, commentURL, got.CommentURL)
	})

	t.Run("stops asking once it is acknowledged", func(t *testing.T) {
		t.Parallel()
		agg, src, _ := ackAggregator(t)
		request(agg)
		src.setAck(dashboard.CommandAck{CommentURL: commentURL, Acknowledged: true}, nil)
		agg.Refresh(t.Context())

		agg.Refresh(t.Context())

		assert.Equal(t, 1, src.callCount())
	})

	t.Run("a forge error leaves the request as it was", func(t *testing.T) {
		t.Parallel()
		agg, src, _ := ackAggregator(t)
		request(agg)
		src.setAck(dashboard.CommandAck{}, errors.New("rate limited"))

		agg.Refresh(t.Context())

		got := botRequestOf(t, agg)
		require.NotNil(t, got)
		assert.Equal(t, dashboard.BotQueued, got.Phase)
		assert.Nil(t, got.AcknowledgedAt)
	})

	t.Run("no thumbs-up in ten minutes is an expired request, still linking the comment", func(t *testing.T) {
		t.Parallel()
		agg, src, clock := ackAggregator(t)
		request(agg)
		src.setAck(dashboard.CommandAck{CommentURL: commentURL}, nil)
		clock.advance(9 * time.Minute)
		agg.Refresh(t.Context())
		assert.Equal(t, dashboard.BotQueued, botRequestOf(t, agg).Phase)

		clock.advance(2 * time.Minute)
		agg.Refresh(t.Context())

		got := botRequestOf(t, agg)
		assert.Equal(t, dashboard.BotExpired, got.Phase)
		assert.Nil(t, got.AcknowledgedAt)
		assert.Equal(t, commentURL, got.CommentURL)
	})

	t.Run("a thumbs-up that arrives after it expired revives the request", func(t *testing.T) {
		t.Parallel()
		agg, src, clock := ackAggregator(t)
		request(agg)
		clock.advance(11 * time.Minute)
		agg.Refresh(t.Context())
		require.Equal(t, dashboard.BotExpired, botRequestOf(t, agg).Phase)
		src.setAck(dashboard.CommandAck{CommentURL: commentURL, Acknowledged: true}, nil)

		agg.Refresh(t.Context())

		got := botRequestOf(t, agg)
		assert.Equal(t, dashboard.BotQueued, got.Phase)
		assert.NotNil(t, got.AcknowledgedAt)
	})

	t.Run("a recreate or a Renovate request is never looked up", func(t *testing.T) {
		t.Parallel()
		agg, src, _ := ackAggregator(t)
		agg.RecordBotRequest(dashboard.ForgeGitHub, "o/r", 7, dashboard.BotRenovate, dashboard.BotRebase)

		agg.Refresh(t.Context())

		assert.Zero(t, src.callCount())
		agg.RecordBotRequest(dashboard.ForgeGitHub, "o/r", 7, dashboard.BotDependabot, dashboard.BotRecreate)
		agg.Refresh(t.Context())
		assert.Zero(t, src.callCount())
	})

	t.Run("tells subscribers when the thumbs-up shows up", func(t *testing.T) {
		t.Parallel()
		agg, src, _ := ackAggregator(t)
		request(agg)
		ch, unsubscribe := agg.Subscribe()
		defer unsubscribe()
		src.setAck(dashboard.CommandAck{CommentURL: commentURL, Acknowledged: true}, nil)

		agg.Refresh(t.Context())

		var last dashboard.Snapshot
		for drained := false; !drained; {
			select {
			case last = <-ch:
			case <-time.After(100 * time.Millisecond):
				drained = true
			}
		}
		require.Len(t, last.PullRequests, 1)
		require.NotNil(t, last.PullRequests[0].BotRequest)
		assert.NotNil(t, last.PullRequests[0].BotRequest.AcknowledgedAt)
	})
}
