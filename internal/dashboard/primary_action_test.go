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
	botBehindWith := func(author string, forge dashboard.Forge, edit func(*dashboard.PullRequest)) dashboard.PullRequest {
		pr := botBehind(author, forge)
		edit(&pr)

		return pr
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
		// The same rule for both bots: behind and not conflicting puts the rebase in the row,
		// whatever Merge or auto-merge are waiting on.
		{"Renovate behind with CI pending: the Renovate rebase", botBehindWith("renovate", dashboard.ForgeForgejo, func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending }), []string{"renovate_rebase"}},
		{"Dependabot behind with CI pending: the Dependabot rebase", botBehindWith("dependabot[bot]", dashboard.ForgeGitHub, func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending }), []string{"dependabot_rebase"}},
		{"Renovate behind with auto-merge armed and CI pending: the Renovate rebase", botBehindWith("renovate", dashboard.ForgeForgejo, func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending; p.AutoMergeEnabled = new(true) }), []string{"renovate_rebase"}},
		{"Dependabot behind with auto-merge armed and CI pending: the Dependabot rebase", botBehindWith("dependabot[bot]", dashboard.ForgeGitHub, func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending; p.AutoMergeEnabled = new(true) }), []string{"dependabot_rebase"}},
		{"Renovate behind with CI pending and the rebase already requested: none, the locked rebase stays", botBehindWith("renovate", dashboard.ForgeForgejo, func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending; p.RenovateRebaseRequested = true }), []string{}},
		{"Dependabot behind with CI pending and a Recreate pending: none, the locked rebase stays", botBehindWith("dependabot[bot]", dashboard.ForgeGitHub, func(p *dashboard.PullRequest) {
			p.CI = dashboard.CIPending
			p.BotRequest = &dashboard.BotRequest{Bot: dashboard.BotDependabot, Action: dashboard.BotRecreate, Phase: dashboard.BotQueued}
		}), []string{}},
		// A rebase can't clear a hold for workflow approval, so the status area
		// keeps the reason and the row has no rebase.
		{"Renovate behind, blocked, failing and awaiting workflow approval: none", botBehindWith("renovate", dashboard.ForgeGitHub, func(p *dashboard.PullRequest) { p.CI = dashboard.CIFailure; p.AwaitingWorkflowApproval = true }), []string{}},
		{"Dependabot behind, blocked, failing and awaiting workflow approval: none", botBehindWith("dependabot[bot]", dashboard.ForgeGitHub, func(p *dashboard.PullRequest) { p.CI = dashboard.CIFailure; p.AwaitingWorkflowApproval = true }), []string{}},
		{"Dependabot behind, unstable, failing and awaiting approval: the rebase, Merge is not held", botBehindWith("dependabot[bot]", dashboard.ForgeGitHub, func(p *dashboard.PullRequest) {
			p.MergeStatus = dashboard.MergeUnstable
			p.CI = dashboard.CIFailure
			p.AwaitingWorkflowApproval = true
		}), []string{"dependabot_rebase"}},
		{"Dependabot behind, awaiting approval but status unknown: none, Merge gives the approval reason", botBehindWith("dependabot[bot]", dashboard.ForgeGitHub, func(p *dashboard.PullRequest) {
			p.MergeStatus = dashboard.MergeUnknown
			p.CI = dashboard.CINone
			p.AwaitingWorkflowApproval = true
		}), []string{}},
		{"person behind, blocked, failing and awaiting approval: none, Merge gives the approval reason", ghPR(func(p *dashboard.PullRequest) {
			p.Behind = true
			p.MergeStatus = dashboard.MergeBlocked
			p.CI = dashboard.CIFailure
			p.AwaitingWorkflowApproval = true
		}), []string{}},
		{"person behind, awaiting approval but status unknown: none, Merge gives the approval reason", ghPR(func(p *dashboard.PullRequest) {
			p.Behind = true
			p.MergeStatus = dashboard.MergeUnknown
			p.CI = dashboard.CINone
			p.AwaitingWorkflowApproval = true
		}), []string{}},
		// One unrelated held run is enough: the approval is the one step that is
		// sure to be needed, so it is the reason even beside a missing review.
		{"person behind, blocked, CI passing and one held run: none, Merge gives the approval reason", ghPR(func(p *dashboard.PullRequest) {
			p.Behind = true
			p.MergeStatus = dashboard.MergeBlocked
			p.CI = dashboard.CISuccess
			p.AwaitingWorkflowApproval = true
		}), []string{}},
		{"person behind, approval granted and run finished: Update branch", ghPR(func(p *dashboard.PullRequest) {
			p.Behind = true
			p.MergeStatus = dashboard.MergeBlocked
			p.CI = dashboard.CIFailure
		}), []string{"update_branch"}},
		{"person behind, not awaiting approval: Update branch", ghPR(func(p *dashboard.PullRequest) {
			p.Behind = true
			p.MergeStatus = dashboard.MergeUnknown
		}), []string{"update_branch"}},
		{"Renovate behind and draft: none", botBehindWith("renovate", dashboard.ForgeForgejo, func(p *dashboard.PullRequest) { p.Draft = true }), []string{}},
		{"Dependabot behind and draft: none", botBehindWith("dependabot[bot]", dashboard.ForgeGitHub, func(p *dashboard.PullRequest) { p.Draft = true }), []string{}},
		{"Renovate behind and stacked: none", botBehindWith("renovate", dashboard.ForgeForgejo, func(p *dashboard.PullRequest) { p.StackedOn = &dashboard.StackRef{Number: 840} }), []string{}},
		{"Dependabot behind and stacked: none", botBehindWith("dependabot[bot]", dashboard.ForgeGitHub, func(p *dashboard.PullRequest) { p.StackedOn = &dashboard.StackRef{Number: 840} }), []string{}},
		{"Renovate behind, unstable with CI failing (Merge open): the Renovate rebase", botBehindWith("renovate", dashboard.ForgeForgejo, func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnstable; p.CI = dashboard.CIFailure }), []string{"renovate_rebase"}},
		{"Dependabot behind, unstable with CI failing (Merge open): the Dependabot rebase", botBehindWith("dependabot[bot]", dashboard.ForgeGitHub, func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnstable; p.CI = dashboard.CIFailure }), []string{"dependabot_rebase"}},
		{"Renovate behind and conflicting: none", botBehindWith("renovate", dashboard.ForgeForgejo, func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting }), []string{}},
		{"Dependabot behind and conflicting: none", botBehindWith("dependabot[bot]", dashboard.ForgeGitHub, func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting }), []string{}},
		{"Renovate not behind with CI pending: none", botBehindWith("renovate", dashboard.ForgeForgejo, func(p *dashboard.PullRequest) { p.Behind = false; p.CI = dashboard.CIPending }), []string{}},
		{"Dependabot not behind with CI pending: none", botBehindWith("dependabot[bot]", dashboard.ForgeGitHub, func(p *dashboard.PullRequest) { p.Behind = false; p.CI = dashboard.CIPending }), []string{}},
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

// A behind bot pull request whose runs wait for approval has no row button,
// since a rebase can't release them, so its status says what does: approve
// the runs, not "bring it up to date".
func TestPullRequestStatus_BehindBotAwaitingApproval(t *testing.T) {
	t.Parallel()

	for _, author := range []string{"renovate", "dependabot[bot]"} {
		pr := ghPR(func(p *dashboard.PullRequest) {
			p.Author = author
			p.Behind = true
			p.MergeStatus = dashboard.MergeBlocked
			p.CI = dashboard.CIFailure
			p.AwaitingWorkflowApproval = true
		})
		actions := dashboard.AllowedActions(pr, []string{"renovate"})
		status := dashboard.PullRequestStatus(pr, actions)

		require.NotNil(t, status, author)
		assert.Equal(t, dashboard.ActionBlockedByProtection, status.Code, author)
		assert.Equal(t, "Workflow runs are waiting for approval", status.Message, author)
		assert.Empty(t, status.Action, author)
		assert.Empty(t, primaries(actions), author)
	}
}

// A behind pull request whose runs wait for approval and whose merge state
// the forge hasn't reported yet says the same as the blocked one: approve the
// runs, not "bring it up to date", for a person and a bot alike.
func TestPullRequestStatus_BehindAwaitingApprovalWithUnknownState(t *testing.T) {
	t.Parallel()

	for _, author := range []string{"someone", "dependabot[bot]"} {
		pr := ghPR(func(p *dashboard.PullRequest) {
			p.Author = author
			p.Behind = true
			p.MergeStatus = dashboard.MergeUnknown
			p.CI = dashboard.CINone
			p.AwaitingWorkflowApproval = true
		})
		actions := dashboard.AllowedActions(pr, nil)
		status := dashboard.PullRequestStatus(pr, actions)

		require.NotNil(t, status, author)
		assert.Equal(t, "Workflow runs are waiting for approval", status.Message, author)
		assert.Empty(t, status.Action, author)
		assert.Empty(t, primaries(actions), author)
	}
}

// A held pull request would only get a head that is held again, so Update
// branch and the bot rebases are listed blocked with Merge's reason: a queued
// run or an API call is refused truthfully, and the board hides them.
func TestAllowedActions_HeldBehindBlocksUpdateAndRebase(t *testing.T) {
	t.Parallel()

	for _, author := range []string{"someone", "renovate", "dependabot[bot]"} {
		pr := ghPR(func(p *dashboard.PullRequest) {
			p.Author = author
			p.Behind = true
			p.MergeStatus = dashboard.MergeUnknown
			p.CI = dashboard.CINone
			p.AwaitingWorkflowApproval = true
		})
		for _, a := range dashboard.AllowedActions(pr, []string{"renovate"}) {
			switch a.Action {
			case dashboard.ActionUpdateBranch, dashboard.ActionRenovateRebase, dashboard.ActionDependabotRebase:
				if assert.NotNil(t, a.Blocked, "%s %s", author, a.Action) {
					assert.Equal(t, "Workflow runs are waiting for approval", a.Blocked.Message, "%s %s", author, a.Action)
				}
			default:
			}
		}
	}
}
