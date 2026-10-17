package dashboard_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// primaries lists the actions the server marks primary.
func primaries(actions []dashboard.ActionAvailability) []string {
	out := []string{}
	for _, a := range actions {
		if a.Primary {
			out = append(out, string(a.Action))
		}
	}

	return out
}

// The server picks the one main button so no client works it out again. The
// table is the rule: Merge when it is ready, Close for an empty pull request,
// Update branch or the bot's own rebase when being behind is what holds Merge
// back, and nothing when the status area has the reason.
func TestAllowedActions_PrimaryAction(t *testing.T) {
	t.Parallel()

	botBehind := func(author string, forge dashboard.Forge) dashboard.PullRequest {
		return ghPR(func(p *dashboard.PullRequest) {
			p.Forge = forge
			p.Author = author
			p.Behind = true
			p.MergeStatus = dashboard.MergeBlocked
		})
	}
	cases := []struct {
		name string
		pr   dashboard.PullRequest
		want []string
	}{
		{"ready to merge: Merge", ghPR(nil), []string{"merge"}},
		{"ready and several actions available: only Merge", ghPR(func(p *dashboard.PullRequest) { p.Behind = true; p.Forge = dashboard.ForgeForgejo }), []string{"merge"}},
		{"unstable with an optional check pending: Merge", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnstable; p.CI = dashboard.CIPending }), []string{"merge"}},
		{"unstable with failing CI: none, the status area explains", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnstable; p.CI = dashboard.CIFailure }), []string{}},
		{"empty: Close", ghPR(func(p *dashboard.PullRequest) { p.Empty = true }), []string{"close"}},
		{"empty and behind: Close", ghPR(func(p *dashboard.PullRequest) { p.Empty = true; p.Behind = true }), []string{"close"}},
		{"behind and not mergeable: Update branch", ghPR(func(p *dashboard.PullRequest) { p.Behind = true; p.MergeStatus = dashboard.MergeBlocked }), []string{"update_branch"}},
		{"release-please behind: Update branch", ghPR(func(p *dashboard.PullRequest) {
			p.Behind = true
			p.MergeStatus = dashboard.MergeBlocked
			p.Labels = []dashboard.Label{{Name: "autorelease: pending"}}
		}), []string{"update_branch"}},
		{"behind and conflicting: none", ghPR(func(p *dashboard.PullRequest) { p.Behind = true; p.MergeStatus = dashboard.MergeConflicting }), []string{}},
		{"behind with checks pending: none", ghPR(func(p *dashboard.PullRequest) {
			p.Behind = true
			p.MergeStatus = dashboard.MergeBlocked
			p.CI = dashboard.CIPending
		}), []string{}},
		{"Renovate waiting on its rebase: the Renovate rebase", botBehind("renovate", dashboard.ForgeForgejo), []string{"renovate_rebase"}},
		{"Renovate rebase already requested: none", ghPR(func(p *dashboard.PullRequest) {
			p.Author = "renovate"
			p.Behind = true
			p.MergeStatus = dashboard.MergeBlocked
			p.RenovateRebaseRequested = true
		}), []string{}},
		{"Dependabot waiting on its rebase: the Dependabot rebase", botBehind("dependabot[bot]", dashboard.ForgeGitHub), []string{"dependabot_rebase"}},
		{"conflicting: none", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting }), []string{}},
		{"draft: none", ghPR(func(p *dashboard.PullRequest) { p.Draft = true }), []string{}},
		{"CI pending: none", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending }), []string{}},
		{"CI failing and blocked: none, not Rerun checks", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeBlocked; p.CI = dashboard.CIFailure }), []string{}},
		{"blocked by the forge: none", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeBlocked }), []string{}},
		{"merge status unknown: none", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnknown }), []string{}},
		{"stacked: none", ghPR(func(p *dashboard.PullRequest) { p.StackedOn = &dashboard.StackRef{Number: 840} }), []string{}},
		{"armed auto-merge waiting on CI: none", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending; p.AutoMergeEnabled = new(true) }), []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.want, primaries(dashboard.AllowedActions(tc.pr, nil)))
		})
	}
}

func TestAllowedActions_PrimaryIsNeverBlocked(t *testing.T) {
	t.Parallel()

	for _, a := range dashboard.AllowedActions(ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending }), nil) {
		assert.False(t, a.Primary && a.Blocked != nil, "%s is blocked and primary", a.Action)
	}
}

// Every state in the committed rule table has zero or one primary action, and
// it is never a blocked one.
func TestAllowedActionsFixture_AtMostOnePrimary(t *testing.T) {
	t.Parallel()

	file := readFixtureFile(t)
	sawPrimary := map[string]bool{}
	for i, out := range file.Outputs {
		got := primaries(out.AllowedActions)
		require.LessOrEqual(t, len(got), 1, "output %d has several primary actions: %v", i, got)
		for _, a := range out.AllowedActions {
			assert.False(t, a.Primary && a.Blocked != nil, "output %d: blocked %s is primary", i, a.Action)
		}
		for _, p := range got {
			sawPrimary[p] = true
		}
	}
	for _, want := range []string{"merge", "close", "update_branch", "renovate_rebase", "dependabot_rebase"} {
		assert.True(t, sawPrimary[want], "no state in the table has %s primary", want)
	}
}

func readFixtureFile(t *testing.T) fixtureFile {
	t.Helper()

	raw, err := os.ReadFile(fixturePath)
	require.NoError(t, err)
	var file fixtureFile
	require.NoError(t, json.Unmarshal(raw, &file))

	return file
}
