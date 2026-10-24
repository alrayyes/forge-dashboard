package api_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A cancel that arrives once Renovate is rebasing is refused with the row's own
// reason, not the generic "no rebase is requested" the row contradicts.
func TestBotActionNotOffered_CancelWhileRenovateIsRebasing_SaysThereIsNothingLeftToCancel(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{
		RenovateRebaseRequested: true,
		BotRequest:              &dashboard.BotRequest{Bot: dashboard.BotRenovate, Phase: dashboard.BotRebasing},
	}

	got := api.BotActionNotOffered(dashboard.ActionCancelRenovateRebase, pr)

	assert.Equal(t, "Renovate is already rebasing; there is nothing left to cancel.", got.Message)
}

func TestBotActionNotOffered_CancelWithNoBoxTicked_KeepsTheGenericMessage(t *testing.T) {
	t.Parallel()

	got := api.BotActionNotOffered(dashboard.ActionCancelRenovateRebase, dashboard.PullRequest{})

	assert.Equal(t, "No Renovate rebase is requested through the rebase box on this pull request.", got.Message)
}
