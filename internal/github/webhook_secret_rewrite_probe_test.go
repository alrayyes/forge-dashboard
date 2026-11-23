package github_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRewriteWebhookSecret_AfterAProbeSawTheHook_PatchesOnceWithoutListing(t *testing.T) {
	t.Parallel()

	f := newFakeHooks(t, true, allHookEvents)
	client := f.probedClient(t)
	listsBefore := f.lists.Load()

	rewritten, err := client.RewriteWebhookSecret(t.Context(), "alrayyes", "a", repairTarget, "new-secret")

	require.NoError(t, err)
	assert.True(t, rewritten)
	assert.EqualValues(t, 0, f.lists.Load()-listsBefore, "the remembered hook needs no listing")
	assert.EqualValues(t, 1, f.patches.Load())
}

func TestRewriteWebhookSecret_RememberedHookIsGone_FallsBackToOneListing(t *testing.T) {
	t.Parallel()

	f := newFakeHooks(t, true, allHookEvents)
	client := f.probedClient(t)
	f.serve(9, true, allHookEvents) // recreated under a new id since the probe
	listsBefore := f.lists.Load()

	rewritten, err := client.RewriteWebhookSecret(t.Context(), "alrayyes", "a", repairTarget, "new-secret")

	require.NoError(t, err)
	assert.True(t, rewritten)
	assert.EqualValues(t, 1, f.lists.Load()-listsBefore)
	assert.Equal(t, []int64{7, 9}, f.patchedIDs(), "the stale id answers 404, then the listed one is patched")
}

func TestRewriteWebhookSecret_RememberedHookIsStale_ListsFirst(t *testing.T) {
	t.Parallel()

	f := newFakeHooks(t, true, allHookEvents)
	client := f.probedClient(t)
	client.SetSeenHookMaxAge(time.Millisecond)
	time.Sleep(20 * time.Millisecond)
	listsBefore := f.lists.Load()

	_, err := client.RewriteWebhookSecret(t.Context(), "alrayyes", "a", repairTarget, "new-secret")

	require.NoError(t, err)
	assert.EqualValues(t, 1, f.lists.Load()-listsBefore)
	assert.Equal(t, []int64{7}, f.patchedIDs())
}

func TestRewriteWebhookSecret_InvalidTargetURL_DoesNotEchoTheWebhookToken(t *testing.T) {
	t.Parallel()

	_, err := github.NewClient("test-token", "", "http://unused.invalid").
		RewriteWebhookSecret(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/github/tok123\x7f", "s")

	require.Error(t, err)
	assert.NotContains(t, err.Error(), "tok123")
}
