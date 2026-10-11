package dashboard_test

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

// queueSource is a GitHub that can be rate limited, lists the pull requests a
// test sets, and records every write it is asked to make. It also offers Merge,
// so a test can prove a queued action never reaches it.
type queueSource struct {
	mu     sync.Mutex
	health dashboard.ForgeHealth
	prs    []dashboard.PullRequest
	calls  []string
	// failWith, when set, is what every write answers.
	failWith error
}

func (s *queueSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (s *queueSource) Fetch(context.Context) dashboard.Result {
	s.mu.Lock()
	defer s.mu.Unlock()

	return dashboard.Result{Health: s.health, PullRequests: append([]dashboard.PullRequest(nil), s.prs...)}
}

func (s *queueSource) record(call string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, call)

	return s.failWith
}

func (s *queueSource) UpdateBranch(_ context.Context, owner, name string, number int) (bool, error) {
	return false, s.record("update " + owner + "/" + name + "#" + strconv.Itoa(number))
}

func (s *queueSource) CommentPullRequest(_ context.Context, _, _ string, number int, body string) error {
	return s.record("comment #" + strconv.Itoa(number) + " " + body)
}

func (s *queueSource) AddLabel(_ context.Context, _, _ string, number int, label string) error {
	return s.record("label #" + strconv.Itoa(number) + " " + label)
}

func (s *queueSource) MergePullRequest(context.Context, string, string, int) error {
	return s.record("MERGE")
}

func (s *queueSource) setHealth(h dashboard.ForgeHealth) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.health = h
}

func (s *queueSource) setPRs(prs ...dashboard.PullRequest) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prs = prs
}

func (s *queueSource) writes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]string(nil), s.calls...)
}

var (
	queueUser = []byte("user-1")
	// queueT0 is the fake clock's start; the limit resets 32 minutes later.
	queueT0    = time.Date(2026, 10, 11, 14, 0, 0, 0, time.UTC)
	queueReset = queueT0.Add(32 * time.Minute)
)

func spentHealth(reset time.Time) dashboard.ForgeHealth {
	return dashboard.ForgeHealth{
		Forge: dashboard.ForgeGitHub, Reachable: true,
		RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: reset},
	}
}

func healthyHealth() dashboard.ForgeHealth {
	return dashboard.ForgeHealth{
		Forge: dashboard.ForgeGitHub, Reachable: true,
		RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: 4999, ResetsAt: queueReset.Add(time.Hour)},
	}
}

func behindPR(number int, author string) dashboard.PullRequest {
	return dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: number, Author: author,
		Behind: true, MergeStatus: dashboard.MergeMergeable, CI: dashboard.CISuccess,
	}
}

func openQueueStore(t *testing.T, path string) *settings.Store {
	t.Helper()

	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	key := make([]byte, 32)
	_, err = rand.Read(key)
	require.NoError(t, err)
	cipher, err := settings.NewCipher(base64.StdEncoding.EncodeToString(key))
	require.NoError(t, err)
	store := settings.NewStore(db, cipher)
	require.NoError(t, store.Init(t.Context()))

	return store
}

// queueRig is one user's aggregator on a fake clock, with a real store.
type queueRig struct {
	agg   *dashboard.Aggregator
	src   *queueSource
	store *settings.Store
	clock *fakeClock
}

// newQueueRig starts GitHub rate limited until queueReset, with the given pull
// requests, and has the aggregator read the board once.
func newQueueRig(t *testing.T, prs ...dashboard.PullRequest) *queueRig {
	t.Helper()

	src := &queueSource{health: spentHealth(queueReset), prs: prs}
	rig := &queueRig{src: src, store: openQueueStore(t, filepath.Join(t.TempDir(), "app.db")), clock: &fakeClock{t: queueT0}}
	rig.agg = rig.newAggregator(t)
	rig.agg.Refresh(t.Context())

	return rig
}

func (r *queueRig) newAggregator(t *testing.T) *dashboard.Aggregator {
	t.Helper()

	agg := dashboard.NewAggregator([]dashboard.Source{r.src}, dashboard.WithClock(r.clock.now), dashboard.WithQueuedActionBuffer(0))
	agg.EnableQueuedActions(queueUser, r.store)

	return agg
}

func (r *queueRig) enqueue(t *testing.T, action dashboard.ActionName, number int) dashboard.QueuedAction {
	t.Helper()

	q, _, err := r.store.EnqueueQueuedAction(t.Context(), queueUser, dashboard.QueuedAction{
		Action: action, Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: number,
		Status: dashboard.QueuedWaiting, RunAt: queueReset, CreatedAt: queueT0,
	})
	require.NoError(t, err)

	return q
}

// resetPasses is the moment the limit lifts: the clock moves past the reset and
// the forge answers with budget again.
func (r *queueRig) resetPasses() {
	r.clock.advance(33 * time.Minute)
	r.src.setHealth(healthyHealth())
}

func (r *queueRig) only(t *testing.T) dashboard.QueuedAction {
	t.Helper()

	items, err := r.store.QueuedActions(t.Context(), queueUser)
	require.NoError(t, err)
	require.Len(t, items, 1)

	return items[0]
}

func TestQueuedActions_RunAtTheReset(t *testing.T) {
	t.Parallel()

	t.Run("update branch runs once the limit lifts and is recorded as done", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(5, "alice"))
		rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
		rig.resetPasses()

		rig.agg.ProcessQueuedActions(t.Context())

		assert.Equal(t, []string{"update o/r#5"}, rig.src.writes())
		got := rig.only(t)
		assert.Equal(t, dashboard.QueuedDone, got.Status)
		require.NotNil(t, got.FinishedAt)
		assert.True(t, rig.clock.now().Equal(*got.FinishedAt))
	})

	t.Run("nothing runs before the reset", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(5, "alice"))
		rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
		rig.clock.advance(31 * time.Minute)

		rig.agg.ProcessQueuedActions(t.Context())

		assert.Empty(t, rig.src.writes())
		assert.Equal(t, dashboard.QueuedWaiting, rig.only(t).Status)
	})

	t.Run("the pull request shows what happened as a request, like a click would", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(5, "alice"))
		rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
		rig.resetPasses()

		rig.agg.ProcessQueuedActions(t.Context())

		prs := rig.agg.Get().PullRequests
		require.Len(t, prs, 1)
		assert.NotNil(t, prs[0].UpdateRequest)
	})

	t.Run("a Dependabot rebase posts the documented comment", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(6, "dependabot[bot]"))
		rig.enqueue(t, dashboard.ActionDependabotRebase, 6)
		rig.resetPasses()

		rig.agg.ProcessQueuedActions(t.Context())

		assert.Equal(t, []string{"comment #6 " + dashboard.DependabotRebaseComment}, rig.src.writes())
		assert.Equal(t, dashboard.QueuedDone, rig.only(t).Status)
		assert.NotNil(t, rig.agg.Get().PullRequests[0].BotRequest)
	})

	t.Run("a Renovate rebase adds the user's rebase label", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(7, "renovate[bot]"))
		rig.enqueue(t, dashboard.ActionRenovateRebase, 7)
		rig.resetPasses()

		rig.agg.ProcessQueuedActions(t.Context())

		require.Len(t, rig.src.writes(), 1)
		assert.Contains(t, rig.src.writes()[0], "label #7 ")
		assert.Equal(t, dashboard.QueuedDone, rig.only(t).Status)
	})
}

func TestQueuedActions_ReCheckTheRequestAtRunTime(t *testing.T) {
	t.Parallel()

	skipped := func(t *testing.T, rig *queueRig, code dashboard.ActionCode) {
		t.Helper()
		assert.Empty(t, rig.src.writes(), "nothing is written")
		got := rig.only(t)
		assert.Equal(t, dashboard.QueuedSkipped, got.Status)
		assert.Equal(t, code, got.Code)
		assert.NotEmpty(t, got.Message, "a skip says why")
		assert.NotNil(t, got.FinishedAt)
	}

	t.Run("a pull request merged or closed meanwhile is skipped", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(5, "alice"))
		rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
		rig.resetPasses()
		rig.src.setPRs()

		rig.agg.ProcessQueuedActions(t.Context())

		skipped(t, rig, dashboard.ActionNotOpen)
	})

	t.Run("a branch that caught up meanwhile is skipped", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(5, "alice"))
		rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
		rig.resetPasses()
		upToDate := behindPR(5, "alice")
		upToDate.Behind = false
		rig.src.setPRs(upToDate)

		rig.agg.ProcessQueuedActions(t.Context())

		skipped(t, rig, dashboard.ActionAlreadyUpToDate)
	})

	t.Run("a conflict that appeared meanwhile is skipped", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(5, "alice"))
		rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
		rig.resetPasses()
		conflicting := behindPR(5, "alice")
		conflicting.MergeStatus = dashboard.MergeConflicting
		rig.src.setPRs(conflicting)

		rig.agg.ProcessQueuedActions(t.Context())

		skipped(t, rig, dashboard.ActionConflict)
	})

	t.Run("a bot that already rebased meanwhile is skipped", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(6, "dependabot[bot]"))
		rig.enqueue(t, dashboard.ActionDependabotRebase, 6)
		rig.resetPasses()
		rebased := behindPR(6, "dependabot[bot]")
		rebased.Behind = false
		rig.src.setPRs(rebased)

		rig.agg.ProcessQueuedActions(t.Context())

		skipped(t, rig, dashboard.ActionAlreadyUpToDate)
	})

	t.Run("a rebase already asked for is not asked twice", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(6, "dependabot[bot]"))
		rig.enqueue(t, dashboard.ActionDependabotRebase, 6)
		rig.resetPasses()
		rig.agg.RecordBotRequest(dashboard.ForgeGitHub, "o/r", 6, dashboard.BotDependabot, dashboard.BotRebase)

		rig.agg.ProcessQueuedActions(t.Context())

		skipped(t, rig, dashboard.ActionAlreadyRequested)
	})

	t.Run("a pull request that no longer offers the action is skipped", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(6, "dependabot[bot]"))
		rig.enqueue(t, dashboard.ActionRenovateRebase, 6)
		rig.resetPasses()

		rig.agg.ProcessQueuedActions(t.Context())

		skipped(t, rig, dashboard.ActionNotMergeable)
	})
}

func TestQueuedActions_NeverMergeOrClose(t *testing.T) {
	t.Parallel()
	rig := newQueueRig(t, behindPR(5, "alice"))
	// The API refuses these, so a row like this only exists if the database
	// was edited. It still must not act.
	for _, action := range []dashboard.ActionName{dashboard.ActionMerge, dashboard.ActionClose} {
		rig.enqueue(t, action, 5)
	}
	rig.resetPasses()

	rig.agg.ProcessQueuedActions(t.Context())

	assert.Empty(t, rig.src.writes())
	items, err := rig.store.QueuedActions(t.Context(), queueUser)
	require.NoError(t, err)
	for _, q := range items {
		assert.Equal(t, dashboard.QueuedFailed, q.Status, q.Action)
	}
}

func TestQueuedActions_CancelledBeforeTheReset_NothingRuns(t *testing.T) {
	t.Parallel()
	rig := newQueueRig(t, behindPR(5, "alice"))
	q := rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
	found, err := rig.store.CancelQueuedAction(t.Context(), queueUser, q.ID)
	require.NoError(t, err)
	require.True(t, found)
	rig.resetPasses()

	rig.agg.ProcessQueuedActions(t.Context())

	assert.Empty(t, rig.src.writes())
}

func TestQueuedActions_SurviveARestart(t *testing.T) {
	t.Parallel()
	rig := newQueueRig(t, behindPR(5, "alice"))
	rig.enqueue(t, dashboard.ActionUpdateBranch, 5)

	// The process dies. A new one opens the same database, builds a new
	// aggregator for the user and reads the board.
	rig.agg = rig.newAggregator(t)
	rig.agg.Refresh(t.Context())
	rig.resetPasses()
	rig.agg.ProcessQueuedActions(t.Context())

	assert.Equal(t, []string{"update o/r#5"}, rig.src.writes())
	assert.Equal(t, dashboard.QueuedDone, rig.only(t).Status)
}

func TestQueuedActions_StillLimitedAtTheReset_WaitForTheNextOne(t *testing.T) {
	t.Parallel()
	rig := newQueueRig(t, behindPR(5, "alice"))
	rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
	rig.clock.advance(33 * time.Minute)
	nextReset := rig.clock.now().Add(20 * time.Minute)
	rig.src.setHealth(spentHealth(nextReset))

	rig.agg.ProcessQueuedActions(t.Context())

	assert.Empty(t, rig.src.writes())
	got := rig.only(t)
	assert.Equal(t, dashboard.QueuedWaiting, got.Status)
	assert.True(t, nextReset.Equal(got.RunAt), "moved to %s", got.RunAt)
}

func TestQueuedActions_TheForgeRateLimitsTheCall_WaitForTheNextReset(t *testing.T) {
	t.Parallel()
	rig := newQueueRig(t, behindPR(5, "alice"))
	rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
	rig.resetPasses()
	nextReset := rig.clock.now().Add(15 * time.Minute)
	rig.src.failWith = &dashboard.ClientError{
		Kind: dashboard.ForgeErrorRateLimited, Err: errors.New("slow down"),
		RateLimit: &dashboard.RateLimit{ResetsAt: nextReset},
	}

	rig.agg.ProcessQueuedActions(t.Context())

	got := rig.only(t)
	assert.Equal(t, dashboard.QueuedWaiting, got.Status)
	assert.True(t, nextReset.Equal(got.RunAt))
}

func TestQueuedActions_TheForgeRefuses_RecordsTheStructuredCode(t *testing.T) {
	t.Parallel()
	rig := newQueueRig(t, behindPR(5, "alice"))
	rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
	rig.resetPasses()
	rig.src.failWith = &dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: errors.New("forbidden")}

	rig.agg.ProcessQueuedActions(t.Context())

	got := rig.only(t)
	assert.Equal(t, dashboard.QueuedFailed, got.Status)
	assert.Equal(t, dashboard.ActionPermission, got.Code)
	assert.NotEmpty(t, got.Message)
}

func TestQueuedActions_ForgeUnreachableAtTheReset(t *testing.T) {
	t.Parallel()

	t.Run("is tried again in a few minutes", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(5, "alice"))
		rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
		rig.resetPasses()
		rig.src.setHealth(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: false})

		rig.agg.ProcessQueuedActions(t.Context())

		got := rig.only(t)
		assert.Equal(t, dashboard.QueuedWaiting, got.Status)
		assert.True(t, rig.clock.now().Before(got.RunAt))
		assert.Empty(t, rig.src.writes())
	})

	t.Run("fails after an hour of trying", func(t *testing.T) {
		t.Parallel()
		rig := newQueueRig(t, behindPR(5, "alice"))
		rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
		rig.resetPasses()
		rig.clock.advance(time.Hour)
		rig.src.setHealth(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: false})

		rig.agg.ProcessQueuedActions(t.Context())

		assert.Equal(t, dashboard.QueuedFailed, rig.only(t).Status)
	})
}

func TestQueuedActions_TheUserLostTheirCredentials_NothingRunsWithoutThem(t *testing.T) {
	t.Parallel()
	rig := newQueueRig(t, behindPR(5, "alice"))
	rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
	rig.resetPasses()
	// The user removed their GitHub token: the rebuilt aggregator has no source.
	agg := dashboard.NewAggregator(nil, dashboard.WithClock(rig.clock.now), dashboard.WithQueuedActionBuffer(0))
	agg.EnableQueuedActions(queueUser, rig.store)

	agg.ProcessQueuedActions(t.Context())

	assert.Empty(t, rig.src.writes())
	got := rig.only(t)
	assert.Equal(t, dashboard.QueuedSkipped, got.Status)
	assert.Equal(t, dashboard.ActionPermission, got.Code)
}

func TestQueuedActions_AnotherUsersAggregator_LeavesTheItemAlone(t *testing.T) {
	t.Parallel()
	rig := newQueueRig(t, behindPR(5, "alice"))
	rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
	rig.resetPasses()
	other := dashboard.NewAggregator([]dashboard.Source{rig.src}, dashboard.WithClock(rig.clock.now), dashboard.WithQueuedActionBuffer(0))
	other.EnableQueuedActions([]byte("user-2"), rig.store)

	other.ProcessQueuedActions(t.Context())

	assert.Empty(t, rig.src.writes())
	assert.Equal(t, dashboard.QueuedWaiting, rig.only(t).Status)
}

func TestQueuedActions_OldFinishedOnesAreForgottenAfterADay(t *testing.T) {
	t.Parallel()
	rig := newQueueRig(t, behindPR(5, "alice"))
	rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
	rig.resetPasses()
	rig.agg.ProcessQueuedActions(t.Context())
	require.Equal(t, dashboard.QueuedDone, rig.only(t).Status)
	rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
	rig.src.setPRs() // so the second one is skipped, not run
	rig.clock.advance(25 * time.Hour)

	rig.agg.ProcessQueuedActions(t.Context())

	items, err := rig.store.QueuedActions(t.Context(), queueUser)
	require.NoError(t, err)
	for _, q := range items {
		assert.NotEqual(t, dashboard.QueuedDone, q.Status, "the day-old outcome is gone")
	}
}

func TestQueuedActions_TheSchedulerRunsItWithoutBeingAsked(t *testing.T) {
	t.Parallel()
	src := &queueSource{health: healthyHealth(), prs: []dashboard.PullRequest{behindPR(5, "alice")}}
	store := openQueueStore(t, filepath.Join(t.TempDir(), "app.db"))
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithQueuedActionBuffer(0))
	agg.EnableQueuedActions(queueUser, store)
	agg.Refresh(t.Context())
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	go agg.RunQueuedActions(ctx)

	// Queued after the scheduler started, with a reset already due: the wake-up
	// is what makes it notice.
	_, _, err := store.EnqueueQueuedAction(t.Context(), queueUser, dashboard.QueuedAction{
		Action: dashboard.ActionUpdateBranch, Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 5,
		Status: dashboard.QueuedWaiting, RunAt: time.Now().Add(-time.Second), CreatedAt: time.Now(),
	})
	require.NoError(t, err)
	agg.QueuedActionsChanged()

	require.Eventually(t, func() bool { return len(src.writes()) == 1 }, 5*time.Second, 20*time.Millisecond)
}
