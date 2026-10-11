package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A subscriber that has not read yet when the next snapshot lands must end up
// holding the newest one (#966). The channel holds one snapshot; dropping the
// newcomer left the stale one in it, so a stream client that was busy while a
// merged pull request left the board kept showing the Merge button until the
// next refresh, however many minutes away.
func TestAggregator_ASlowSubscriberEndsUpWithTheNewestSnapshot(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 78}})
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	ch, unsubscribe := agg.Subscribe()
	defer unsubscribe()

	// Two updates while the subscriber is not reading: the pull request is
	// still listed, then it merges.
	require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a"))
	src.setRepo("alrayyes/a", nil)
	require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a"))

	assert.Empty(t, (<-ch).PullRequests, "the snapshot a subscriber reads next must be the newest one")
}
