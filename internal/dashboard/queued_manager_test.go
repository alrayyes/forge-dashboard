package dashboard_test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/require"
)

// A Manager given a queue store starts the scheduler with every user's
// dashboard, so a queued action whose reset has passed runs without anyone
// opening the page. That is also how a restart keeps its promise: the new
// process starts the dashboard, which reads the stored queue.
func TestManager_WithAQueueStore_RunsADueQueuedActionAfterAStart(t *testing.T) {
	t.Parallel()
	src := &queueSource{health: healthyHealth(), prs: []dashboard.PullRequest{behindPR(5, "alice")}}
	store := openQueueStore(t, filepath.Join(t.TempDir(), "app.db"))
	_, _, err := store.EnqueueQueuedAction(t.Context(), queueUser, dashboard.QueuedAction{
		Action: dashboard.ActionUpdateBranch, Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 5,
		Status: dashboard.QueuedWaiting, RunAt: time.Now().Add(-time.Hour), CreatedAt: time.Now().Add(-2 * time.Hour),
	})
	require.NoError(t, err)
	manager := dashboard.NewManager(time.Hour)
	t.Cleanup(manager.Stop)
	manager.SetQueuedActionStore(store)

	manager.EnsureIfAbsent(t.Context(), queueUser, []dashboard.Source{src})

	require.Eventually(t, func() bool { return len(src.writes()) == 1 }, 10*time.Second, 50*time.Millisecond)
}
