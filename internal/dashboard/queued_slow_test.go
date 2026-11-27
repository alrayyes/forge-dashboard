package dashboard_test

import (
	"context"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// updatingSource is a ctxSource that can update a branch.
type updatingSource struct {
	*ctxSource
	updates atomic.Int32
}

func (s *updatingSource) UpdateBranch(context.Context, string, string, int) (bool, error) {
	s.updates.Add(1)

	return false, nil
}

type slowQueue struct {
	lateFixture
	src   *updatingSource
	store *settings.Store
}

// newSlowQueue has read its forge once, with #10 up to date, and made the
// forge slow.
func newSlowQueue(t *testing.T) slowQueue {
	t.Helper()

	src := &updatingSource{ctxSource: newCtxSource()}
	f := lateFixture{src: src.ctxSource, timers: newFakeTimers()}
	f.agg = dashboard.NewAggregator([]dashboard.Source{src},
		dashboard.WithClock(f.timers.Now),
		dashboard.WithFetchDeadline(lateScheduledDeadline, f.timers.After),
		dashboard.WithUserFetchDeadline(lateUserDeadline),
		dashboard.WithQueuedActionBuffer(0))
	q := slowQueue{lateFixture: f, src: src, store: openQueueStore(t, filepath.Join(t.TempDir(), "app.db"))}
	q.agg.EnableQueuedActions(q.store)
	q.agg.Refresh(t.Context())
	src.slow.Store(true)

	return q
}

// behindNow is the forge's new read, in which #10 has fallen behind.
func (q slowQueue) behindNow() dashboard.Result {
	res := q.src.rows(10)
	res.PullRequests[0].Behind = true
	res.PullRequests[0].MergeStatus = dashboard.MergeMergeable

	return res
}

// enqueue queues an update of #10 that came due ago.
func (q slowQueue) enqueue(t *testing.T, ago time.Duration) {
	t.Helper()

	_, _, err := q.store.EnqueueQueuedAction(t.Context(), dashboard.QueuedAction{
		Action: dashboard.ActionUpdateBranch, Forge: dashboard.ForgeForgejo, Repo: "o/r", Number: 10,
		Status: dashboard.QueuedWaiting, RunAt: q.timers.Now().Add(-ago), CreatedAt: q.timers.Now().Add(-ago - time.Minute),
	})
	require.NoError(t, err)
}

func (q slowQueue) only(t *testing.T) dashboard.QueuedAction {
	t.Helper()

	items, err := q.store.QueuedActions(t.Context())
	require.NoError(t, err)
	require.Len(t, items, 1)

	return items[0]
}

func (q slowQueue) assertWaiting(t *testing.T) {
	t.Helper()

	got := q.only(t)
	assert.Equal(t, dashboard.QueuedWaiting, got.Status, got.Message)
	assert.True(t, q.timers.Now().Before(got.RunAt), "not moved to a later try")
	assert.Zero(t, q.src.updates.Load())
}

// Held rows are old: a pull request that looks up to date in them may have
// fallen behind since, and a skip is final (#5082).
func TestAggregator_AQueuedActionIsNotDecidedFromASlowForgesHeldRows(t *testing.T) {
	t.Parallel()

	t.Run("while its read is still running", func(t *testing.T) {
		t.Parallel()
		q := newSlowQueue(t)
		q.giveUp(t, func() { q.agg.Refresh(t.Context()) })
		q.enqueue(t, time.Minute)

		q.agg.ProcessQueuedActions(t.Context())

		q.assertWaiting(t)
		h := health(q.agg.Get(), dashboard.ForgeForgejo)
		assert.True(t, dashboard.ClaimOf(dashboard.ClaimAction, h, true).ActionsOpen, "a person's row actions stay open")
	})

	t.Run("when its read was missed", func(t *testing.T) {
		t.Parallel()
		q := newSlowQueue(t)
		q.enqueue(t, time.Minute)

		done := q.start(t, func() { q.agg.ProcessQueuedActions(t.Context()) })
		q.timers.Advance(lateScheduledDeadline)
		<-done

		q.assertWaiting(t)
	})

	t.Run("and is given up an hour after it came due", func(t *testing.T) {
		t.Parallel()
		q := newSlowQueue(t)
		q.giveUp(t, func() { q.agg.Refresh(t.Context()) })
		q.enqueue(t, time.Hour)

		q.agg.ProcessQueuedActions(t.Context())

		got := q.only(t)
		assert.Equal(t, dashboard.QueuedFailed, got.Status)
		assert.Equal(t, "The forge didn't answer. Try again in a moment.", got.Message)
		assert.Zero(t, q.src.updates.Load())
	})
}

// Nobody is watching the queued runner's read, so it waits as long as the
// schedule does. A forge that always takes longer than a person would wait
// would otherwise never be decided on.
func TestAggregator_TheQueuedRunnerWaitsTheScheduledDeadlineForNewRows(t *testing.T) {
	t.Parallel()
	q := newSlowQueue(t)
	q.enqueue(t, time.Minute)

	done := q.start(t, func() { q.agg.ProcessQueuedActions(t.Context()) })
	require.Equal(t, lateScheduledDeadline, q.timers.NextIn(), "how long the runner waits")
	q.timers.Advance(lateScheduledDeadline - time.Second)
	q.src.answer <- q.behindNow()
	<-done

	assert.EqualValues(t, 1, q.src.updates.Load())
	assert.Equal(t, dashboard.QueuedDone, q.only(t).Status)
}

// A person who asks while the runner reads still waits only their own deadline.
func TestAggregator_AClickJoiningTheQueuedRunnersPassStopsAtTheUserDeadline(t *testing.T) {
	t.Parallel()
	q := newSlowQueue(t)
	q.enqueue(t, time.Minute)
	runner := q.start(t, func() { q.agg.ProcessQueuedActions(t.Context()) })
	armed := q.timers.Pending()
	clicked := make(chan struct{})
	go func() {
		defer close(clicked)
		q.agg.Refresh(t.Context())
	}()
	require.Eventually(t, func() bool { return q.timers.Pending() > armed }, 10*time.Second, time.Millisecond)

	q.timers.Advance(lateUserDeadline)
	<-runner

	require.Empty(t, q.src.cancelled)
	q.assertWaiting(t)
	q.src.answer <- q.behindNow()
	<-clicked
}

// A pass that starts with a person already waiting for it is theirs, whoever's
// closure it runs.
func TestAggregator_APassBegunWithAPersonWaitingStopsAtTheUserDeadline(t *testing.T) {
	t.Parallel()

	leaders := map[string]func(context.Context, slowQueue){
		"queued behind a scheduled pass": func(ctx context.Context, q slowQueue) {
			q.agg.Refresh(dashboard.BackgroundForTest(ctx))
		},
		"queued behind the queued runner's pass": func(ctx context.Context, q slowQueue) {
			q.agg.ProcessQueuedActions(ctx)
		},
	}
	for name, leader := range leaders {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			q := newSlowQueue(t)
			q.enqueue(t, time.Minute)
			first := q.start(t, func() { leader(t.Context(), q) })
			clicked := make(chan struct{})
			go func() {
				defer close(clicked)
				q.agg.Refresh(t.Context())
			}()
			require.Eventually(t, func() bool { return q.agg.ParkedRefreshesForTest() == 1 }, 10*time.Second, time.Millisecond)

			q.src.answer <- q.src.rows(10)
			<-q.src.entered // the pass the click waits for
			q.timers.Advance(lateUserDeadline)

			select {
			case <-clicked:
			case <-time.After(10 * time.Second):
				assert.Fail(t, "the click waited past the user deadline")
			}
			q.src.answer <- q.src.rows(10)
			<-clicked
			<-first
		})
	}
}

// The runner joins nothing: a scheduled pass already reading keeps its time.
func TestAggregator_TheQueuedRunnerDoesNotShortenAScheduledPassInFlight(t *testing.T) {
	t.Parallel()
	q := newSlowQueue(t)
	q.enqueue(t, time.Minute)
	scheduled := q.start(t, func() { q.agg.Refresh(dashboard.BackgroundForTest(t.Context())) })
	runner := make(chan struct{})
	go func() {
		defer close(runner)
		q.agg.ProcessQueuedActions(t.Context())
	}()
	require.Eventually(t, func() bool { return q.agg.ParkedRefreshesForTest() == 1 }, 10*time.Second, time.Millisecond)

	assert.Equal(t, lateScheduledDeadline, q.timers.NextIn(), "how long the scheduled pass has")

	q.src.answer <- q.behindNow()
	<-q.src.entered // the pass the runner waits for
	q.src.answer <- q.behindNow()
	<-runner
	<-scheduled
}
