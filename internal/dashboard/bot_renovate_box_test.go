package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func boxPR(ticked bool) dashboard.PullRequest {
	pr := botPR("a", true, dashboard.CIFailure)
	pr.RenovateRebaseRequested = ticked

	return pr
}

func TestAggregator_SetRenovateRebaseBox(t *testing.T) {
	t.Parallel()

	t.Run("clearing the box drops a Renovate request still waiting on it", func(t *testing.T) {
		t.Parallel()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))
		agg.RecordBotRequest(dashboard.ForgeGitHub, "o/r", 7, dashboard.BotRenovate, dashboard.BotRebase)

		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, false)

		assert.Nil(t, botRequestOf(t, agg))
	})

	t.Run("clearing the box leaves a Dependabot request alone", func(t *testing.T) {
		t.Parallel()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))
		request(agg)

		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, false)

		assert.NotNil(t, botRequestOf(t, agg))
	})

	t.Run("a pull request the snapshot does not hold is ignored and tells nobody", func(t *testing.T) {
		t.Parallel()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))
		ch, unsubscribe := agg.Subscribe()
		defer unsubscribe()

		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 99, true)

		select {
		case <-ch:
			t.Fatal("a snapshot was pushed for an unknown pull request")
		case <-time.After(50 * time.Millisecond):
		}
	})

	t.Run("ticking the box shows it on the pull request", func(t *testing.T) {
		t.Parallel()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))

		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)

		assert.True(t, agg.Get().PullRequests[0].RenovateRebaseRequested)
	})

	t.Run("a fetch that read the description before a cancel can't bring the box back", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(true))
		agg, _ := botAggregator(t, src)
		src.mu.Lock()
		src.gate, src.started = make(chan struct{}), make(chan struct{})
		gate, started := src.gate, src.started
		src.mu.Unlock()

		done := make(chan struct{})
		go func() { agg.Refresh(t.Context()); close(done) }()
		<-started
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, false)
		close(gate)
		<-done

		assert.False(t, agg.Get().PullRequests[0].RenovateRebaseRequested)
	})

	t.Run("a fetch that starts after the cancel reads the forge again", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(true))
		agg, _ := botAggregator(t, src)
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, false)

		agg.Refresh(t.Context())

		assert.True(t, agg.Get().PullRequests[0].RenovateRebaseRequested)
	})
}

func TestAggregator_RecordRenovateRebase(t *testing.T) {
	t.Parallel()

	t.Run("one snapshot carries both the request and the ticked box", func(t *testing.T) {
		t.Parallel()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))
		ch, unsubscribe := agg.Subscribe()
		defer unsubscribe()

		agg.RecordRenovateRebase(dashboard.ForgeGitHub, "o/r", 7)

		select {
		case snap := <-ch:
			require.Len(t, snap.PullRequests, 1)
			assert.NotNil(t, snap.PullRequests[0].BotRequest)
			assert.True(t, snap.PullRequests[0].RenovateRebaseRequested)
		case <-time.After(time.Second):
			t.Fatal("no snapshot pushed")
		}

		select {
		case <-ch:
			t.Fatal("a second snapshot was pushed for one request")
		case <-time.After(50 * time.Millisecond):
		}
	})
}

func TestAggregator_RefreshKeepsABoxSetDuringTheFetch(t *testing.T) {
	t.Parallel()

	t.Run("a box ticked while the fetch is out stays ticked on the snapshot it swaps in", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(false))
		agg, _ := botAggregator(t, src)
		src.mu.Lock()
		src.gate, src.started = make(chan struct{}), make(chan struct{})
		gate, started := src.gate, src.started
		src.mu.Unlock()

		done := make(chan struct{})
		go func() { agg.Refresh(t.Context()); close(done) }()
		<-started
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)
		close(gate)
		<-done

		assert.True(t, agg.Get().PullRequests[0].RenovateRebaseRequested)
	})
}

func TestAggregator_BoxOverrideLifetime(t *testing.T) {
	t.Parallel()

	t.Run("a pull request that leaves the board takes its override with it", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(false))
		agg, _ := botAggregator(t, src)
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)
		require.Equal(t, 1, agg.BoxOverrideCount())

		src.set()
		agg.Refresh(t.Context())

		assert.Zero(t, agg.BoxOverrideCount())
	})

	t.Run("a forge that failed to answer keeps the override", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(false))
		agg, _ := botAggregator(t, src)
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)

		src.mu.Lock()
		src.reachable = false
		src.mu.Unlock()
		agg.Refresh(t.Context())

		assert.Equal(t, 1, agg.BoxOverrideCount())
	})

	t.Run("an override set after the fetch began survives a fetch that could not list the pull request", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(false))
		agg, _ := botAggregator(t, src)
		src.mu.Lock()
		src.gate, src.started = make(chan struct{}), make(chan struct{})
		gate, started := src.gate, src.started
		src.prs = nil
		src.mu.Unlock()

		done := make(chan struct{})
		go func() { agg.Refresh(t.Context()); close(done) }()
		<-started
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)
		close(gate)
		<-done

		assert.Equal(t, 1, agg.BoxOverrideCount())
	})
}

func TestAggregator_FullRefreshKeepsTheBoxOverrideOfRowsItCarriedOver(t *testing.T) {
	t.Parallel()

	t.Run("a repo whose pull request list failed", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(false))
		agg, _ := botAggregator(t, src)
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)
		require.Equal(t, 1, agg.BoxOverrideCount())

		src.mu.Lock()
		src.prs = nil
		src.failed = []dashboard.FailedRepo{{FullName: "o/r", PullRequests: true}}
		src.mu.Unlock()
		agg.Refresh(t.Context())

		require.Len(t, agg.Get().PullRequests, 1, "the failed repo's rows were carried over")
		assert.Equal(t, 1, agg.BoxOverrideCount(), "no fetch read #7's description")
	})

	t.Run("a repo the source skipped as unchanged", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(false))
		agg, _ := botAggregator(t, src)
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)

		src.mu.Lock()
		src.prs = nil
		src.unchanged = []string{"o/r"}
		src.mu.Unlock()
		agg.Refresh(t.Context())

		require.Len(t, agg.Get().PullRequests, 1, "the skipped repo's rows were carried over")
		assert.Equal(t, 1, agg.BoxOverrideCount(), "no fetch read #7's description")
	})

	t.Run("a forge whose budget is spent is not asked", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(false))
		agg, clock := botAggregator(t, src)
		src.mu.Lock()
		src.spent = &dashboard.RateLimit{Limit: 5000, ResetsAt: clock.now().Add(time.Hour)}
		src.mu.Unlock()
		agg.Refresh(t.Context())
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)
		require.Equal(t, 1, agg.BoxOverrideCount())

		src.set()
		agg.Refresh(t.Context())

		require.Len(t, agg.Get().PullRequests, 1, "the spent forge's rows were carried over")
		assert.Equal(t, 1, agg.BoxOverrideCount(), "no fetch read #7's description")
	})

	t.Run("a forge held for background refreshes", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(false))
		agg, clock := botAggregator(t, src)
		// Under the reserve but not spent: only the background hold keeps it back.
		src.mu.Lock()
		src.spent = &dashboard.RateLimit{
			Limit: 5000, Remaining: 100, ResetsAt: clock.now().Add(time.Hour),
		}
		src.mu.Unlock()
		agg.Refresh(t.Context())
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)
		require.Equal(t, 1, agg.BoxOverrideCount())

		src.set()
		agg.Refresh(dashboard.BackgroundForTest(t.Context()))

		require.Len(t, agg.Get().PullRequests, 1, "the held forge's rows were carried over")
		assert.Equal(t, 1, agg.BoxOverrideCount(), "no fetch read #7's description")
	})

	t.Run("a forge that is unreachable", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(false))
		agg, _ := botAggregator(t, src)
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)

		src.mu.Lock()
		src.reachable = false
		src.mu.Unlock()
		agg.Refresh(t.Context())

		require.Len(t, agg.Get().PullRequests, 1, "the unreachable forge's rows were carried over")
		assert.Equal(t, 1, agg.BoxOverrideCount())
	})

	t.Run("a repo it did fetch still retires the override", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(false))
		agg, _ := botAggregator(t, src)
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)

		agg.Refresh(t.Context())

		assert.Zero(t, agg.BoxOverrideCount())
	})
}

func TestAggregator_PollCIKeepsTheBoxOverrideOfAPullRequestItDidNotRead(t *testing.T) {
	t.Parallel()

	src := newBatchSource()
	quiet := dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 8, CI: dashboard.CISuccess}
	src.setRepo("o/r", []dashboard.PullRequest{pendingPR("o/r", 7), quiet})
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 8, true)
	require.Equal(t, 1, agg.BoxOverrideCount())

	agg.PollCI(t.Context())

	require.Len(t, src.lastBatch(), 1, "only the pending pull request is asked about")
	assert.Equal(t, 1, agg.BoxOverrideCount(), "the poll never read #8's description")
}

func TestNoteRenovateRebase(t *testing.T) {
	t.Parallel()

	note := func(t *testing.T, outcome dashboard.RenovateRebaseOutcome) dashboard.PullRequest {
		t.Helper()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))
		dashboard.NoteRenovateRebase(agg, dashboard.ForgeGitHub, "o/r", 7, outcome)

		return agg.Get().PullRequests[0]
	}

	t.Run("a ticked box shows the request and the box together", func(t *testing.T) {
		t.Parallel()
		pr := note(t, dashboard.RenovateRebaseTicked)

		assert.True(t, pr.RenovateRebaseRequested)
		require.NotNil(t, pr.BotRequest)
		assert.Equal(t, dashboard.BotRenovate, pr.BotRequest.Bot)
	})

	t.Run("a box found ticked shows the box and records no request", func(t *testing.T) {
		t.Parallel()
		pr := note(t, dashboard.RenovateRebaseAlreadyRequested)

		assert.True(t, pr.RenovateRebaseRequested)
		assert.Nil(t, pr.BotRequest)
	})

	t.Run("a label shows the request and leaves the box alone", func(t *testing.T) {
		t.Parallel()
		pr := note(t, dashboard.RenovateRebaseLabeled)

		assert.False(t, pr.RenovateRebaseRequested)
		require.NotNil(t, pr.BotRequest)
		assert.Equal(t, dashboard.BotRenovate, pr.BotRequest.Bot)
	})
}
