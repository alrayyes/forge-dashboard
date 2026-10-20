package api

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"path/filepath"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func newAutoUpdateTestStore(t *testing.T) *settings.Store {
	t.Helper()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "settings.db"))
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

func snapshotWith(reachable bool, open ...int) dashboard.Snapshot {
	snap := dashboard.Snapshot{
		Forges: []dashboard.ForgeHealth{{Forge: dashboard.ForgeGitHub, Reachable: reachable}},
		Repos:  []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a"}},
	}
	for _, n := range open {
		snap.PullRequests = append(snap.PullRequests, dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: n})
	}

	return snap
}

func boardWithChoices(t *testing.T, store *settings.Store, userID []byte) boardSettings {
	t.Helper()
	choices, err := store.PullRequestAutoUpdates(t.Context(), userID)
	require.NoError(t, err)

	return boardSettings{autoUpdateChoices: choices}
}

func TestForgetClosedAutoUpdates_DropsTheChoiceOfAPullRequestThatIsNoLongerOpen(t *testing.T) {
	t.Parallel()
	store := newAutoUpdateTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.SetPullRequestAutoUpdate(t.Context(), userID, "github", "alrayyes/a", 7, false))
	require.NoError(t, store.SetPullRequestAutoUpdate(t.Context(), userID, "github", "alrayyes/a", 8, false))
	board := boardWithChoices(t, store, userID)

	board.forgetClosedAutoUpdates(t.Context(), store, userID, snapshotWith(true, 8))

	got, err := store.PullRequestAutoUpdates(t.Context(), userID)
	require.NoError(t, err)
	assert.Equal(t, map[string]bool{settings.AutoMergeKey("github", "alrayyes/a", 8): false}, got)
	assert.Len(t, board.autoUpdateChoices, 1, "the response is built without the dropped choice too")
}

func TestForgetClosedAutoUpdates_AnOutageIsNotAClose(t *testing.T) {
	t.Parallel()
	store := newAutoUpdateTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.SetPullRequestAutoUpdate(t.Context(), userID, "github", "alrayyes/a", 7, false))
	board := boardWithChoices(t, store, userID)

	board.forgetClosedAutoUpdates(t.Context(), store, userID, snapshotWith(false))

	got, err := store.PullRequestAutoUpdates(t.Context(), userID)
	require.NoError(t, err)
	assert.Len(t, got, 1, "the forge did not answer, so nothing is known to have closed")
}
