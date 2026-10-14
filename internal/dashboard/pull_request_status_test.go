package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An empty pull request offers Close and no Merge, so the reason Merge used to
// carry has to travel on its own (#1375).
func TestPullRequestStatus_EmptyExplainsWhyThereIsNothingToMerge(t *testing.T) {
	t.Parallel()

	pr := ghPR(func(p *dashboard.PullRequest) { p.Empty = true })

	got := dashboard.PullRequestStatus(pr, dashboard.AllowedActions(pr, nil))

	require.NotNil(t, got)
	assert.Equal(t, dashboard.ActionAlreadyUpToDate, got.Code)
	assert.Equal(t, "Nothing to merge: the branch is already on the target branch.", got.Message)
	assert.NotEmpty(t, got.Next, "Close is what the user can do about it")
}

func TestPullRequestStatus_WaitingCasesUseTheSamePlace(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		mutate   func(*dashboard.PullRequest)
		wantCode dashboard.ActionCode
		wantMsg  string
	}{
		{"ci pending", func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending }, dashboard.ActionChecksPending, "Waiting for CI to finish"},
		{"stacked", func(p *dashboard.PullRequest) { p.StackedOn = &dashboard.StackRef{Number: 840} }, dashboard.ActionStacked, "Stacked on #840. Merge that one first."},
		{"conflict", func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting }, dashboard.ActionConflict, "Merge conflict"},
		{"draft", func(p *dashboard.PullRequest) { p.Draft = true }, dashboard.ActionNotMergeable, "Draft pull request"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			pr := ghPR(tt.mutate)

			got := dashboard.PullRequestStatus(pr, dashboard.AllowedActions(pr, nil))

			require.NotNil(t, got)
			assert.Equal(t, tt.wantCode, got.Code)
			assert.Equal(t, tt.wantMsg, got.Message)
		})
	}
}

func TestPullRequestStatus_NothingWhenReadyToMerge(t *testing.T) {
	t.Parallel()

	pr := ghPR(nil)

	assert.Nil(t, dashboard.PullRequestStatus(pr, dashboard.AllowedActions(pr, nil)))
}
