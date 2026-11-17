package dashboard

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// withForge adds a forge to the capability table for one test, so the rules
// are shown to follow the table and not the forge's name.
func withForge(t *testing.T, f Forge, c ForgeCapabilities) {
	t.Helper()

	capabilitiesByForge[f] = c
	t.Cleanup(func() { delete(capabilitiesByForge, f) })
}

func TestAutoMergeRules_FollowTheCapabilityNotTheForgeName(t *testing.T) {
	// Not parallel: it edits the shared table.
	on := true
	heldByApp := Forge("heldforge")
	heldByForge := Forge("selfforge")
	withForge(t, heldByApp, ForgeCapabilities{AutoMergeHeldByApp: true})
	withForge(t, heldByForge, ForgeCapabilities{AutoMergeHeldByApp: false})

	pr := func(f Forge) PullRequest {
		return PullRequest{Forge: f, MergeStatus: MergeMergeable, CI: CIPending}
	}

	assert.True(t, autoMergeOffered(pr(heldByApp)), "offered where the app holds it")
	assert.True(t, autoMergeOffered(pr(heldByForge)), "offered where the forge holds it")

	draft := pr(heldByApp)
	draft.Draft = true
	assert.False(t, autoMergeOffered(draft), "an app-held draft has nothing to arm")

	armed := pr(heldByForge)
	armed.AutoMergeEnabled = &on
	assert.True(t, armedOnForge(armed), "a forge-held armed pull request is polled for")
	armed.Forge = heldByApp
	assert.False(t, armedOnForge(armed), "an app-held one is merged by the app, not polled for")
	assert.False(t, armedOnForge(PullRequest{Forge: "nope", AutoMergeEnabled: &on}))

	assert.True(t, AppMergesArmed(heldByApp))
	assert.False(t, AppMergesArmed(heldByForge))
	assert.False(t, AppMergesArmed("nope"))
}
