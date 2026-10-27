package api_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var (
	watchedPR = api.CheckSubject{Kind: "pull_request", Forge: "github", FullName: "alrayyes/tempus-fugit", Number: 7}
	otherPR   = api.CheckSubject{Kind: "pull_request", Forge: "github", FullName: "alrayyes/tempus-fugit", Number: 8}
	watchedMB = api.CheckSubject{Kind: "main_branch", Forge: "github", FullName: "alrayyes/tempus-fugit"}
)

// lists stands in for the forge. Each call to fetch is numbered from 1 and
// announces itself on started, then waits on its gate when the test made one,
// so a test decides the order the reads finish in. A call answers one check
// named for its number, or fails when its number is in failing.
type lists struct {
	calls   atomic.Int64
	started chan int64
	gates   map[int64]chan struct{}
	failing map[int64]bool
	subject chan api.CheckSubject
	ci      atomic.Value // dashboard.CIStatus
	status  atomic.Value // dashboard.MainBranchStatus
}

func newLists(gated ...int64) *lists {
	l := &lists{
		started: make(chan int64, 16),
		gates:   map[int64]chan struct{}{},
		failing: map[int64]bool{},
		subject: make(chan api.CheckSubject, 16),
	}
	for _, n := range gated {
		l.gates[n] = make(chan struct{})
	}
	l.ci.Store(dashboard.CIPending)
	l.status.Store(dashboard.MainBranchStatus(""))

	return l
}

func (l *lists) fetch(s api.CheckSubject) ([]dashboard.Check, error) {
	n := l.calls.Add(1)
	l.subject <- s
	l.started <- n
	if gate, ok := l.gates[n]; ok {
		<-gate
	}
	if l.failing[n] {
		return nil, errors.New("the forge said no")
	}

	return []dashboard.Check{{Name: fmt.Sprintf("call %d", n)}}, nil
}

func (l *lists) snapshot() dashboard.Snapshot {
	ci, _ := l.ci.Load().(dashboard.CIStatus)
	status, _ := l.status.Load().(dashboard.MainBranchStatus)

	return dashboard.Snapshot{
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/tempus-fugit", Number: 7, CI: ci},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/tempus-fugit", Number: 8, CI: ci},
		},
		MainBranches: []dashboard.MainBranch{
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/tempus-fugit", Status: status},
		},
	}
}

func (l *lists) watch(t *testing.T) *api.CheckWatch {
	t.Helper()

	return api.NewCheckWatch(t.Context(), l.fetch, l.snapshot)
}

func (l *lists) awaitStart(t *testing.T) int64 {
	t.Helper()
	select {
	case n := <-l.started:
		return n
	case <-time.After(pollBudget):
		t.Fatal("no read started")

		return 0
	}
}

// release lets the read numbered n finish.
func (l *lists) release(n int64) { close(l.gates[n]) }

type watchEvent struct {
	Kind     string `json:"kind"`
	Number   int    `json:"number"`
	FullName string `json:"fullName"`
	Error    string `json:"error"`
	Checks   []struct {
		Name string `json:"name"`
	} `json:"checks"`
}

func next(t *testing.T, w *api.CheckWatch) watchEvent {
	t.Helper()
	select {
	case data := <-w.Out():
		var ev watchEvent
		require.NoError(t, json.Unmarshal(data, &ev))

		return ev
	case <-time.After(pollBudget):
		t.Fatal("no event arrived")

		return watchEvent{}
	}
}

func (e watchEvent) answered(n int64) bool {
	return len(e.Checks) == 1 && e.Checks[0].Name == fmt.Sprintf("call %d", n)
}

func TestCheckWatch_ANewSubjectIsListedAndAnswered(t *testing.T) {
	t.Parallel()

	l := newLists()
	w := l.watch(t)

	w.Set([]api.CheckSubject{watchedPR}, false)

	ev := next(t, w)
	assert.Equal(t, "pull_request", ev.Kind)
	assert.Equal(t, 7, ev.Number)
	assert.True(t, ev.answered(1))
}

func TestCheckWatch_AMainBranchIsListedByItsRepo(t *testing.T) {
	t.Parallel()

	l := newLists()
	w := l.watch(t)

	w.Set([]api.CheckSubject{watchedMB}, false)

	ev := next(t, w)
	assert.Equal(t, "main_branch", ev.Kind)
	assert.Equal(t, "alrayyes/tempus-fugit", ev.FullName)
	assert.Equal(t, watchedMB, <-l.subject)
}

func TestCheckWatch_ASubjectAlreadyWatchedIsNotListedWithoutRefresh(t *testing.T) {
	t.Parallel()

	l := newLists()
	w := l.watch(t)
	w.Set([]api.CheckSubject{watchedPR}, false)
	next(t, w)

	// otherPR is new, so its answer proves the set was processed. watchedPR
	// would have been listed before it.
	w.Set([]api.CheckSubject{watchedPR, otherPR}, false)

	ev := next(t, w)
	assert.Equal(t, 8, ev.Number)
	assert.EqualValues(t, 2, l.calls.Load())
}

func TestCheckWatch_RefreshListsAWatchedSubjectAgain(t *testing.T) {
	t.Parallel()

	l := newLists()
	w := l.watch(t)
	w.Set([]api.CheckSubject{watchedPR}, false)
	next(t, w)

	w.Set([]api.CheckSubject{watchedPR}, true)

	assert.True(t, next(t, w).answered(2))
}

func TestCheckWatch_ASnapshotOfTheSameRowListsNothing(t *testing.T) {
	t.Parallel()

	l := newLists()
	w := l.watch(t)
	w.Set([]api.CheckSubject{watchedPR}, false)
	next(t, w)

	w.OnSnapshot(l.snapshot())
	l.ci.Store(dashboard.CISuccess)
	w.OnSnapshot(l.snapshot())

	// One read for the change, none for the snapshot before it.
	assert.True(t, next(t, w).answered(2))
	assert.EqualValues(t, 2, l.calls.Load())
}

func TestCheckWatch_ASnapshotWithoutTheRowListsNothing(t *testing.T) {
	t.Parallel()

	l := newLists()
	w := l.watch(t)
	w.Set([]api.CheckSubject{watchedPR}, false)
	next(t, w)

	w.OnSnapshot(dashboard.Snapshot{})
	l.ci.Store(dashboard.CISuccess)
	w.OnSnapshot(l.snapshot())

	assert.True(t, next(t, w).answered(2))
	assert.EqualValues(t, 2, l.calls.Load())
}

func TestCheckWatch_AMainBranchIsListedAgainWhenItsStatusMoves(t *testing.T) {
	t.Parallel()

	l := newLists()
	w := l.watch(t)
	w.Set([]api.CheckSubject{watchedMB}, false)
	next(t, w)

	l.status.Store(dashboard.MainBranchStatus("failure"))
	w.OnSnapshot(l.snapshot())

	ev := next(t, w)
	assert.Equal(t, "main_branch", ev.Kind)
	assert.True(t, ev.answered(2))
}

func TestCheckWatch_AFailedListSaysSoAndEveryLaterSnapshotReadsAgain(t *testing.T) {
	t.Parallel()

	l := newLists()
	l.failing[1], l.failing[2] = true, true
	w := l.watch(t)
	w.Set([]api.CheckSubject{watchedPR}, false)
	failed := next(t, w)
	assert.NotEmpty(t, failed.Error)
	assert.Empty(t, failed.Checks)

	// The row did not move, yet the next snapshots read again until one works.
	w.OnSnapshot(l.snapshot())
	assert.NotEmpty(t, next(t, w).Error)
	w.OnSnapshot(l.snapshot())
	assert.True(t, next(t, w).answered(3))

	w.OnSnapshot(l.snapshot())
	l.ci.Store(dashboard.CISuccess)
	w.OnSnapshot(l.snapshot())
	assert.True(t, next(t, w).answered(4), "a read that worked is not repeated for the same row")
}

// nothingQueued waits for every goroutine of the bubble to settle, so a stale
// read that was going to send has sent, and says nothing is waiting on Out.
func nothingQueued(t *testing.T, w *api.CheckWatch) {
	t.Helper()
	synctest.Wait()
	select {
	case data := <-w.Out():
		t.Fatalf("unexpected event: %s", data)
	default:
	}
}

func TestCheckWatch_ARefreshOvertakesAReadStillOut(t *testing.T) {
	t.Parallel()

	synctest.Test(t, func(t *testing.T) {
		l := newLists(1, 2)
		w := l.watch(t)
		w.Set([]api.CheckSubject{watchedPR}, false)
		require.EqualValues(t, 1, l.awaitStart(t))
		w.Set([]api.CheckSubject{watchedPR}, true)
		require.EqualValues(t, 2, l.awaitStart(t))

		l.release(2)
		assert.True(t, next(t, w).answered(2))
		l.release(1)

		nothingQueued(t, w)
	})
}

func TestCheckWatch_AChangeBeforeTheFirstReadFinishesStartsItOver(t *testing.T) {
	t.Parallel()

	synctest.Test(t, func(t *testing.T) {
		l := newLists(1, 2)
		w := l.watch(t)
		w.Set([]api.CheckSubject{watchedPR}, false)
		require.EqualValues(t, 1, l.awaitStart(t))

		l.ci.Store(dashboard.CISuccess)
		w.OnSnapshot(l.snapshot())
		require.EqualValues(t, 2, l.awaitStart(t))

		l.release(2)
		assert.True(t, next(t, w).answered(2))
		l.release(1)

		nothingQueued(t, w)
	})
}

func TestCheckWatch_ASetReplacesWhatWasWatched(t *testing.T) {
	t.Parallel()

	synctest.Test(t, func(t *testing.T) {
		l := newLists(1)
		w := l.watch(t)
		w.Set([]api.CheckSubject{watchedPR}, false)
		require.EqualValues(t, 1, l.awaitStart(t))

		w.Set([]api.CheckSubject{otherPR}, false)
		assert.Equal(t, 1, w.Watching())
		assert.Equal(t, 8, next(t, w).Number)
		l.release(1)

		nothingQueued(t, w)
	})
}

func TestCheckWatches_ASecondOpenOfTheSameStreamReplacesTheFirst(t *testing.T) {
	t.Parallel()

	watches := api.NewCheckWatches()
	first := watches.Open(t.Context(), watchedStreamID)
	second := watches.Open(t.Context(), watchedStreamID)

	assert.Same(t, second, watches.Find(watchedStreamID))

	watches.Close(watchedStreamID, first)
	assert.Same(t, second, watches.Find(watchedStreamID), "closing the replaced stream leaves the new one")

	watches.Close(watchedStreamID, second)
	assert.Nil(t, watches.Find(watchedStreamID))
}

func TestCheckWatches_AStreamIDThatIsNotWellFormedWatchesNothing(t *testing.T) {
	t.Parallel()

	assert.Nil(t, api.NewCheckWatches().Open(t.Context(), "no"))
}
