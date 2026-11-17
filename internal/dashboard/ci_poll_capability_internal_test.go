package dashboard

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestPollableBranches_FollowTheChecksViaWebhookCapability(t *testing.T) {
	// Not parallel: it edits the shared table.
	polled := Forge("polledforge")
	hooked := Forge("hookedforge")
	withForge(t, polled, ForgeCapabilities{ChecksViaWebhook: false})
	withForge(t, hooked, ForgeCapabilities{ChecksViaWebhook: true})

	snap := Snapshot{MainBranches: []MainBranch{
		{Forge: polled, FullName: "o/polled", Status: MainBranchRunning},
		{Forge: hooked, FullName: "o/hooked", Status: MainBranchRunning},
		{Forge: "nope", FullName: "o/unknown", Status: MainBranchRunning},
	}}

	got := pollableBranches(snap, time.Now())

	if assert.Len(t, got, 1, "only a forge without check webhooks has its branches polled") {
		assert.Equal(t, "o/polled", got[0].FullName)
	}
}

type hookedSource struct{ forge Forge }

func (s hookedSource) Fetch(context.Context) Result { return Result{} }
func (s hookedSource) Forge() Forge                 { return s.forge }
func (s hookedSource) WebhookEvents(string) ([]string, bool) {
	return []string{"check_run"}, true
}

func TestChecksArriveByWebhook_FollowTheCapabilityNotTheForgeName(t *testing.T) {
	// Not parallel: it edits the shared table.
	hooked := Forge("hookedforge")
	polled := Forge("polledforge")
	withForge(t, hooked, ForgeCapabilities{ChecksViaWebhook: true})
	withForge(t, polled, ForgeCapabilities{ChecksViaWebhook: false})

	now := time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)
	agg := NewAggregator([]Source{hookedSource{hooked}, hookedSource{polled}}, WithClock(func() time.Time { return now }))
	item := func(f Forge) pendingItem {
		return pendingItem{ref: PullRequestRef{Forge: f, FullName: "o/r", Number: 1}, ciPending: true, headSHA: "abc"}
	}
	agg.RecordCheckDelivery(hooked, "o/r", "abc")
	agg.RecordCheckDelivery(polled, "o/r", "abc")

	assert.True(t, agg.checksArriveByWebhook(item(hooked), now, time.Minute), "a webhook forge waits for its delivery")
	assert.False(t, agg.checksArriveByWebhook(item(polled), now, time.Minute), "a polled forge never waits")
}

func TestChecksViaWebhook(t *testing.T) {
	// Not parallel: it edits the shared table.
	polled := Forge("polledforge")
	withForge(t, polled, ForgeCapabilities{ChecksViaWebhook: false})

	assert.True(t, checksViaWebhook(ForgeGitHub))
	assert.False(t, checksViaWebhook(polled))
	assert.False(t, checksViaWebhook("nope"))
}
