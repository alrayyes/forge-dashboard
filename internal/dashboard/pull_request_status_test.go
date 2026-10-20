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

// A behind pull request's warning names the action that clears it, so a client
// draws the cure inside the warning and holds no rule of its own.
func TestPullRequestStatus_BehindNamesTheActionThatFixesIt(t *testing.T) {
	t.Parallel()

	behind := func(mutate func(*dashboard.PullRequest)) dashboard.PullRequest {
		return ghPR(func(p *dashboard.PullRequest) {
			p.Behind = true
			p.MergeStatus = dashboard.MergeBlocked
			if mutate != nil {
				mutate(p)
			}
		})
	}
	tests := []struct {
		name       string
		pr         dashboard.PullRequest
		renovate   []string
		wantAction dashboard.ActionName
	}{
		{"a person's pull request", behind(nil), nil, dashboard.ActionUpdateBranch},
		{"dependabot", behind(func(p *dashboard.PullRequest) { p.Author = "dependabot[bot]" }), nil, dashboard.ActionDependabotRebase},
		{"renovate", behind(func(p *dashboard.PullRequest) { p.Author = "renovate[bot]" }), []string{"renovate[bot]"}, dashboard.ActionRenovateRebase},
		{"renovate with a rebase already waiting", behind(func(p *dashboard.PullRequest) {
			p.Author = "renovate[bot]"
			p.RenovateRebaseRequested = true
		}), []string{"renovate[bot]"}, ""},
		{"a conflicting pull request", behind(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting }), nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := dashboard.PullRequestStatus(tt.pr, dashboard.AllowedActions(tt.pr, tt.renovate))

			require.NotNil(t, got)
			assert.Equal(t, tt.wantAction, got.Action)
		})
	}
}

func TestPullRequestStatus_OnlyBehindCarriesAnAction(t *testing.T) {
	t.Parallel()

	pr := ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending })

	got := dashboard.PullRequestStatus(pr, dashboard.AllowedActions(pr, nil))

	require.NotNil(t, got)
	assert.Empty(t, got.Action)
}
