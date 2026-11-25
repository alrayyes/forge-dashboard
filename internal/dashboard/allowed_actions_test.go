package dashboard_test

import (
	"sort"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// summary flattens a pull request's allowed actions to "action" for an
// enabled one and "action:code" for a blocked one, sorted, so a case reads as
// one line of what the page offers.
func summary(pr dashboard.PullRequest) []string {
	return summaryWith(pr, nil)
}

// summaryWith is summary for a user who has set renovateAuthors in Settings.
func summaryWith(pr dashboard.PullRequest, renovateAuthors []string) []string {
	out := []string{}
	for _, a := range dashboard.AllowedActions(pr, renovateAuthors) {
		s := string(a.Action)
		if a.Blocked != nil {
			s += ":" + string(a.Blocked.Code)
		}
		out = append(out, s)
	}
	sort.Strings(out)

	return out
}

func ghPR(mutate func(*dashboard.PullRequest)) dashboard.PullRequest {
	pr := dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 1, Author: "alice",
		CI: dashboard.CISuccess, MergeStatus: dashboard.MergeMergeable,
	}
	if mutate != nil {
		mutate(&pr)
	}

	return pr
}

// The cases pin what the page offers today (#805), so moving the rules behind
// the API changes nothing a user sees. Precedence inside Merge matters: empty,
// conflicting, draft, CI pending, behind, blocked, then unknown.
func TestAllowedActions(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		pr   dashboard.PullRequest
		want []string
	}{
		{"clean and mergeable: merge and close; auto-merge adds nothing", ghPR(nil), []string{"close", "merge"}},
		{"empty: only close, no merge (#1375)", ghPR(func(p *dashboard.PullRequest) { p.Empty = true }), []string{"close"}},
		{"conflicting", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting }), []string{"close", "merge:conflict"}},
		{"conflicting and behind: update branch is locked too", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting; p.Behind = true }), []string{"close", "merge:conflict", "update_branch:conflict"}},
		{"draft that is not mergeable", ghPR(func(p *dashboard.PullRequest) { p.Draft = true; p.MergeStatus = dashboard.MergeBlocked }), []string{"auto_merge", "close", "merge:not_mergeable"}},
		{"draft that GitHub calls clean is still blocked (#957)", ghPR(func(p *dashboard.PullRequest) { p.Draft = true }), []string{"close", "merge:not_mergeable"}},
		{"unstable with a failing optional check still merges (#955)", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnstable; p.CI = dashboard.CIFailure }), []string{"auto_merge", "close", "merge", "rerun_checks"}},
		{"unstable with an optional check pending still merges (#956)", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnstable; p.CI = dashboard.CIPending }), []string{"auto_merge", "cancel_run", "close", "merge"}},
		{"CI pending locks merge even when mergeable", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending }), []string{"auto_merge", "cancel_run", "close", "merge:checks_pending"}},
		{"behind and not mergeable", ghPR(func(p *dashboard.PullRequest) { p.Behind = true; p.MergeStatus = dashboard.MergeBlocked }), []string{"auto_merge", "close", "merge:behind", "update_branch"}},
		{"behind and waiting for CI (Forgejo): update branch stays open (#2837)", ghPR(func(p *dashboard.PullRequest) {
			p.Forge = dashboard.ForgeForgejo
			p.Behind = true
			p.CI = dashboard.CIPending
		}), []string{"auto_merge", "cancel_run", "close", "merge:checks_pending", "update_branch"}},
		{"behind and waiting for CI (GitHub): update branch stays open (#2837)", ghPR(func(p *dashboard.PullRequest) {
			p.Behind = true
			p.CI = dashboard.CIPending
		}), []string{"auto_merge", "cancel_run", "close", "merge:checks_pending", "update_branch"}},
		{"behind but mergeable keeps merge (Forgejo)", ghPR(func(p *dashboard.PullRequest) { p.Forge = dashboard.ForgeForgejo; p.Behind = true }), []string{"auto_merge", "close", "merge", "update_branch"}},
		{"blocked with CI failing", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeBlocked; p.CI = dashboard.CIFailure }), []string{"auto_merge", "close", "merge:checks_failing", "rerun_checks"}},
		{"failing CI on GitHub offers rerunning the failed checks (#698)", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIFailure }), []string{"auto_merge", "close", "merge", "rerun_checks"}},
		{"CI failing only because a workflow is held for approval offers no rerun (#1946)", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIFailure; p.FailingOnlyForApproval = true }), []string{"auto_merge", "close", "merge"}},
		{"failing CI on Forgejo offers rerunning the failed checks (#1032)", ghPR(func(p *dashboard.PullRequest) { p.Forge = dashboard.ForgeForgejo; p.CI = dashboard.CIFailure }), []string{"auto_merge", "close", "merge", "rerun_checks"}},
		{"passing CI on Forgejo has nothing to rerun", ghPR(func(p *dashboard.PullRequest) { p.Forge = dashboard.ForgeForgejo; p.CI = dashboard.CISuccess }), []string{"close", "merge"}},
		{"running CI on Forgejo offers cancelling the run", ghPR(func(p *dashboard.PullRequest) { p.Forge = dashboard.ForgeForgejo; p.CI = dashboard.CIPending }), []string{"auto_merge", "cancel_run", "close", "merge:checks_pending"}},
		{"a failed job beside jobs still running offers cancelling the rest", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIFailure; p.Checks.Running = 1 }), []string{"auto_merge", "cancel_run", "close", "merge", "rerun_checks"}},
		{"a failed job beside jobs waiting to start offers cancelling them", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIFailure; p.Checks.Waiting = 1 }), []string{"auto_merge", "cancel_run", "close", "merge", "rerun_checks"}},
		{"finished CI offers nothing to cancel", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CISuccess }), []string{"close", "merge"}},
		{"blocked otherwise", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeBlocked }), []string{"auto_merge", "close", "merge:blocked_by_protection"}},
		{"merge status not known yet", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnknown }), []string{"auto_merge", "close", "merge:status_unknown"}},
		{"auto-merge already on is not offered again, but can be cancelled", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending; p.AutoMergeEnabled = new(true) }), []string{"cancel_auto_merge", "cancel_run", "close", "merge:checks_pending"}},
		{"auto-merge refused by the forge for this PR", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending; p.AutoMergeAllowed = new(false) }), []string{"cancel_run", "close", "merge:checks_pending"}},
		{"Forgejo with CI pending offers the app's own auto-merge", ghPR(func(p *dashboard.PullRequest) { p.Forge = dashboard.ForgeForgejo; p.CI = dashboard.CIPending }), []string{"auto_merge", "cancel_run", "close", "merge:checks_pending"}},
		{"Forgejo that is already clean has nothing to wait for", ghPR(func(p *dashboard.PullRequest) { p.Forge = dashboard.ForgeForgejo }), []string{"close", "merge"}},
		{"Forgejo draft is not offered auto-merge", ghPR(func(p *dashboard.PullRequest) {
			p.Forge = dashboard.ForgeForgejo
			p.Draft = true
			p.CI = dashboard.CIPending
		}), []string{"cancel_run", "close", "merge:not_mergeable"}},
		{"Forgejo armed offers cancelling instead", ghPR(func(p *dashboard.PullRequest) {
			p.Forge = dashboard.ForgeForgejo
			p.CI = dashboard.CIPending
			p.AutoMergeEnabled = new(true)
		}), []string{"cancel_auto_merge", "cancel_run", "close", "merge:checks_pending"}},
		{"Forgejo armed with conflicts can still be cancelled", ghPR(func(p *dashboard.PullRequest) {
			p.Forge = dashboard.ForgeForgejo
			p.MergeStatus = dashboard.MergeConflicting
			p.AutoMergeEnabled = new(true)
		}), []string{"cancel_auto_merge", "close", "merge:conflict"}},
		{"GitHub armed offers cancelling too (#1293)", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending; p.AutoMergeEnabled = new(true) }), []string{"cancel_auto_merge", "cancel_run", "close", "merge:checks_pending"}},
		{"Dependabot behind on GitHub gets its own rebase, not update branch", ghPR(func(p *dashboard.PullRequest) { p.Author = "dependabot[bot]"; p.Behind = true }), []string{"auto_merge", "close", "dependabot_rebase", "dependabot_recreate", "merge"}},
		{"Dependabot on Forgejo gets no bot commands", ghPR(func(p *dashboard.PullRequest) {
			p.Forge = dashboard.ForgeForgejo
			p.Author = "dependabot"
			p.Behind = true
		}), []string{"auto_merge", "close", "merge"}},
		{"Renovate behind gets its rebase on either forge", ghPR(func(p *dashboard.PullRequest) {
			p.Forge = dashboard.ForgeForgejo
			p.Author = "renovate"
			p.Behind = true
		}), []string{"auto_merge", "close", "merge", "renovate_rebase"}},
		{"release-please behind keeps update branch", ghPR(func(p *dashboard.PullRequest) {
			p.Behind = true
			p.Labels = []dashboard.Label{{Name: "autorelease: pending"}}
		}), []string{"auto_merge", "close", "merge", "update_branch"}},
		{"empty release-please behind: only close, no update branch", ghPR(func(p *dashboard.PullRequest) {
			p.Empty = true
			p.Behind = true
			p.Labels = []dashboard.Label{{Name: "autorelease: pending"}}
		}), []string{"close"}},
		{"stacked on an open parent: merge is blocked and auto-merge is gone", ghPR(func(p *dashboard.PullRequest) { p.StackedOn = &dashboard.StackRef{Number: 840} }), []string{"close", "merge:stacked"}},
		{"stacked beats CI pending as the reason", ghPR(func(p *dashboard.PullRequest) {
			p.StackedOn = &dashboard.StackRef{Number: 840}
			p.CI = dashboard.CIPending
		}), []string{"cancel_run", "close", "merge:stacked"}},
		{"empty beats stacked", ghPR(func(p *dashboard.PullRequest) { p.StackedOn = &dashboard.StackRef{Number: 840}; p.Empty = true }), []string{"close"}},
		{"the bottom of a stack merges as usual", ghPR(func(p *dashboard.PullRequest) { p.StackChildren = []int{853} }), []string{"close", "merge"}},
		{"empty and behind: no update branch", ghPR(func(p *dashboard.PullRequest) { p.Empty = true; p.Behind = true }), []string{"close"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.want, summary(tc.pr))
		})
	}
}

func TestAllowedActions_BlockedMergeSaysWhatToDoNext(t *testing.T) {
	t.Parallel()

	pr := ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending })

	var merge dashboard.ActionAvailability
	for _, a := range dashboard.AllowedActions(pr, nil) {
		if a.Action == dashboard.ActionMerge {
			merge = a
		}
	}

	if assert.NotNil(t, merge.Blocked) {
		assert.Equal(t, "Waiting for CI to finish", merge.Blocked.Message)
		assert.Empty(t, merge.Blocked.Next)
	}
}

// The words the Merge button shows for each way it can be held back. The page
// prints blocked.message and blocked.next as they come and maps nothing itself,
// so this is where each state's reason is pinned.
func TestAllowedActions_BlockedMergeReasonPerState(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		mutate   func(*dashboard.PullRequest)
		wantCode dashboard.ActionCode
		message  string
		next     string
	}{
		{"CI pending", func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending }, dashboard.ActionChecksPending, "Waiting for CI to finish", ""},
		{"workflow runs awaiting approval", func(p *dashboard.PullRequest) {
			p.MergeStatus = dashboard.MergeBlocked
			p.CI = dashboard.CIFailure
			p.AwaitingWorkflowApproval = true
		}, dashboard.ActionBlockedByProtection, "Workflow runs are waiting for approval", "Approve them on GitHub to unlock Merge"},
		{"blocked with a failing check", func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeBlocked; p.CI = dashboard.CIFailure }, dashboard.ActionChecksFailing, "Blocked, CI is failing", ""},
		{"blocked with only a cancelled run", func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeBlocked; p.CI = dashboard.CICancelled }, dashboard.ActionBlockedByProtection, "Blocked, the only run was cancelled", "Run the checks again to unlock Merge"},
		{"blocked with passing CI does not invent a failing check", func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeBlocked; p.CI = dashboard.CISuccess }, dashboard.ActionBlockedByProtection, "Blocked by the forge", "A required check or review is missing"},
		{"conflicting", func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting }, dashboard.ActionConflict, "Merge conflict", "Resolve it on the forge to unlock Merge"},
		{"conflict the forge has not confirmed", func(p *dashboard.PullRequest) {
			p.MergeStatus = dashboard.MergeConflicting
			no := false
			p.ConflictConfirmed = &no
		}, dashboard.ActionConflict, "Conflict not confirmed", "The forge hasn't confirmed it. Wait for it to finish checking, or open the pull request on the forge"},
		{"conflict the forge has not confirmed, behind with Update branch on offer", func(p *dashboard.PullRequest) {
			p.MergeStatus = dashboard.MergeConflicting
			p.Behind = true
			no := false
			p.ConflictConfirmed = &no
		}, dashboard.ActionConflict, "Conflict not confirmed", "The forge hasn't confirmed it. Update the branch to find out"},
		{"conflict the forge has not confirmed, behind but Renovate rebases it", func(p *dashboard.PullRequest) {
			p.MergeStatus = dashboard.MergeConflicting
			p.Behind = true
			p.Author = "renovate[bot]"
			no := false
			p.ConflictConfirmed = &no
		}, dashboard.ActionConflict, "Conflict not confirmed", "The forge hasn't confirmed it. Wait for it to finish checking, or open the pull request on the forge"},
		{"conflict a refusal named", func(p *dashboard.PullRequest) {
			p.MergeStatus = dashboard.MergeConflicting
			yes := true
			p.ConflictConfirmed = &yes
		}, dashboard.ActionConflict, "Merge conflict", "Resolve it on the forge to unlock Merge"},
		{"checking for conflicts", func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeChecking; p.Behind = true }, dashboard.ActionChecksPending, "Checking for conflicts", ""},
		{"behind the base branch", func(p *dashboard.PullRequest) { p.Behind = true; p.MergeStatus = dashboard.MergeBlocked }, dashboard.ActionBehind, "Behind the base branch", ""},
		{"draft", func(p *dashboard.PullRequest) { p.Draft = true }, dashboard.ActionNotMergeable, "Draft pull request", ""},
		{"merge status not known yet", func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnknown }, dashboard.ActionStatusUnknown, "Merge status not known yet", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var merge dashboard.ActionAvailability
			for _, a := range dashboard.AllowedActions(ghPR(tc.mutate), nil) {
				if a.Action == dashboard.ActionMerge {
					merge = a
				}
			}

			if assert.NotNil(t, merge.Blocked) {
				assert.Equal(t, tc.wantCode, merge.Blocked.Code)
				assert.Equal(t, tc.message, merge.Blocked.Message)
				assert.Equal(t, tc.next, merge.Blocked.Next)
			}
		})
	}
}

func TestAllowedActions_HeldRunsOnAMergeablePullRequest_DoNotLockMerge(t *testing.T) {
	t.Parallel()

	for _, a := range dashboard.AllowedActions(ghPR(func(p *dashboard.PullRequest) { p.AwaitingWorkflowApproval = true }), nil) {
		if a.Action == dashboard.ActionMerge {
			assert.Nil(t, a.Blocked, "GitHub says it can merge, so a held non-required run is no reason to lock it")
		}
	}
}

// Waiting for CI is the headline alone, armed or not: how Merge unlocks is
// explained in docs/how-merge-is-held-back.md (#4672).
func TestAllowedActions_ChecksPendingNextDependsOnAutoMerge(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		on   bool
		next string
	}{
		{"auto-merge off prints the headline only", false, ""},
		{"auto-merge on prints the headline only", true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			pr := ghPR(func(p *dashboard.PullRequest) {
				p.CI = dashboard.CIPending
				p.AutoMergeEnabled = &tc.on
			})

			var merge dashboard.ActionAvailability
			for _, a := range dashboard.AllowedActions(pr, nil) {
				if a.Action == dashboard.ActionMerge {
					merge = a
				}
			}

			if assert.NotNil(t, merge.Blocked) {
				assert.Equal(t, dashboard.ActionChecksPending, merge.Blocked.Code)
				assert.Equal(t, "Waiting for CI to finish", merge.Blocked.Message)
				assert.Equal(t, tc.next, merge.Blocked.Next)
			}
		})
	}
}

func TestAllowedActions_StackedMergeNamesTheParent(t *testing.T) {
	t.Parallel()

	pr := ghPR(func(p *dashboard.PullRequest) { p.StackedOn = &dashboard.StackRef{Number: 840} })

	var merge dashboard.ActionAvailability
	for _, a := range dashboard.AllowedActions(pr, nil) {
		if a.Action == dashboard.ActionMerge {
			merge = a
		}
	}

	if assert.NotNil(t, merge.Blocked) {
		assert.Equal(t, "Stacked on #840. Merge that one first.", merge.Blocked.Message)
		assert.Equal(t, "Merge unlocks once #840 merges and this pull request is retargeted.", merge.Blocked.Next)
	}
}

// A Forgejo instance has no Renovate App, so its Renovate account has whatever
// name the instance gave it. The user says which logins are Renovate's (#1062).
func TestAllowedActions_RenovateAuthorsComeFromSettings(t *testing.T) {
	t.Parallel()

	behind := ghPR(func(p *dashboard.PullRequest) {
		p.Forge = dashboard.ForgeForgejo
		p.Author = "mend-bot"
		p.Behind = true
	})

	assert.Equal(t, []string{"auto_merge", "close", "merge", "update_branch"}, summaryWith(behind, nil),
		"an unknown account is a person's pull request")
	assert.Equal(t, []string{"auto_merge", "close", "merge", "renovate_rebase"}, summaryWith(behind, []string{"mend-bot"}))
	assert.Equal(t, []string{"auto_merge", "close", "merge", "renovate_rebase"}, summaryWith(behind, []string{"Mend-Bot"}),
		"forge logins aren't case sensitive")
	assert.Equal(t, []string{"auto_merge", "close", "merge", "update_branch"}, summaryWith(behind, []string{"someone-else"}))
}

func actionNames(pr dashboard.PullRequest) []dashboard.ActionName {
	names := []dashboard.ActionName{}
	for _, a := range dashboard.AllowedActions(pr, nil) {
		names = append(names, a.Action)
	}

	return names
}

// While Renovate's rebase box is ticked a rebase is already requested, so the
// request is not offered at all, only the cancel that unticks the box.
func TestAllowedActions_RenovateBoxTickedOffersOnlyTheCancel(t *testing.T) {
	t.Parallel()

	pr := ghPR(func(p *dashboard.PullRequest) {
		p.Author = "renovate[bot]"
		p.RenovateRebaseRequested = true
	})

	names := actionNames(pr)
	assert.Contains(t, names, dashboard.ActionCancelRenovateRebase)
	assert.NotContains(t, names, dashboard.ActionRenovateRebase)
	for _, a := range dashboard.AllowedActions(pr, nil) {
		if a.Action == dashboard.ActionCancelRenovateRebase {
			assert.Nil(t, a.Blocked)
		}
	}
}

// Once Renovate has taken the box and is rebasing, clearing it withdraws
// nothing and drops the in-progress record, so the cancel is not offered.
func TestAllowedActions_RenovateRebasingOffersNoCancel(t *testing.T) {
	t.Parallel()

	pr := ghPR(func(p *dashboard.PullRequest) {
		p.Author = "renovate[bot]"
		p.RenovateRebaseRequested = true
		p.BotRequest = &dashboard.BotRequest{Bot: dashboard.BotRenovate, Action: dashboard.BotRebase, Phase: dashboard.BotRebasing}
	})

	names := actionNames(pr)
	assert.NotContains(t, names, dashboard.ActionCancelRenovateRebase)
	assert.NotContains(t, names, dashboard.ActionRenovateRebase)
}

func TestAllowedActions_RenovateRequestWithoutABoxOffersNeitherButton(t *testing.T) {
	t.Parallel()

	pr := ghPR(func(p *dashboard.PullRequest) {
		p.Author = "renovate[bot]"
		p.BotRequest = &dashboard.BotRequest{Bot: dashboard.BotRenovate, Action: dashboard.BotRebase, Phase: dashboard.BotQueued}
	})

	names := actionNames(pr)
	assert.NotContains(t, names, dashboard.ActionRenovateRebase)
	assert.NotContains(t, names, dashboard.ActionCancelRenovateRebase, "a label request has no cancel")
}

func TestAllowedActions_RenovateCancelIsNotOfferedWithoutARequest(t *testing.T) {
	t.Parallel()

	pr := ghPR(func(p *dashboard.PullRequest) { p.Author = "renovate[bot]" })

	assert.NotContains(t, actionNames(pr), dashboard.ActionCancelRenovateRebase)
}

func TestAllowedActions_RenovateRebaseIsOfferedWhenItsBoxIsNotTicked(t *testing.T) {
	t.Parallel()

	pr := ghPR(func(p *dashboard.PullRequest) { p.Author = "renovate[bot]" })

	for _, a := range dashboard.AllowedActions(pr, nil) {
		if a.Action == dashboard.ActionRenovateRebase {
			assert.Nil(t, a.Blocked)

			return
		}
	}
	t.Fatal("renovate_rebase was not offered")
}

func TestAllowedActions_ARebaseRequestOnAPersonsPullRequestOffersNothing(t *testing.T) {
	t.Parallel()

	pr := ghPR(func(p *dashboard.PullRequest) { p.RenovateRebaseRequested = true })

	for _, a := range dashboard.AllowedActions(pr, nil) {
		assert.NotEqual(t, dashboard.ActionRenovateRebase, a.Action)
		assert.NotEqual(t, dashboard.ActionCancelRenovateRebase, a.Action)
	}
}

func dependabotCommands(pr dashboard.PullRequest) []dashboard.ActionName {
	var found []dashboard.ActionName
	for _, name := range actionNames(pr) {
		if name == dashboard.ActionDependabotRebase || name == dashboard.ActionDependabotRecreate {
			found = append(found, name)
		}
	}

	return found
}

// A Dependabot command has no cancel, so while a Rebase or a Recreate is
// pending neither button is offered and the waiting chip says what is going on.
// A request that has expired offers both again.
func TestAllowedActions_PendingDependabotCommandOffersNeitherButton(t *testing.T) {
	t.Parallel()

	dependabot := func(req *dashboard.BotRequest) dashboard.PullRequest {
		return ghPR(func(p *dashboard.PullRequest) {
			p.Author = "dependabot[bot]"
			p.BotRequest = req
		})
	}
	pending := func(action dashboard.BotAction, phase dashboard.BotPhase) *dashboard.BotRequest {
		return &dashboard.BotRequest{Bot: dashboard.BotDependabot, Action: action, Phase: phase}
	}

	for name, req := range map[string]*dashboard.BotRequest{
		"queued rebase":   pending(dashboard.BotRebase, dashboard.BotQueued),
		"rebasing":        pending(dashboard.BotRebase, dashboard.BotRebasing),
		"queued recreate": pending(dashboard.BotRecreate, dashboard.BotQueued),
		"recreating":      pending(dashboard.BotRecreate, dashboard.BotRebasing),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			assert.Empty(t, dependabotCommands(dependabot(req)))
		})
	}

	t.Run("an expired request and no request offer both", func(t *testing.T) {
		t.Parallel()

		for _, req := range []*dashboard.BotRequest{nil, pending(dashboard.BotRecreate, dashboard.BotExpired)} {
			assert.Equal(t, []dashboard.ActionName{dashboard.ActionDependabotRebase, dashboard.ActionDependabotRecreate}, dependabotCommands(dependabot(req)))
		}
	})

	t.Run("a Renovate request does not hide a Dependabot action", func(t *testing.T) {
		t.Parallel()

		req := &dashboard.BotRequest{Bot: dashboard.BotRenovate, Action: dashboard.BotRebase, Phase: dashboard.BotQueued}
		assert.Len(t, dependabotCommands(dependabot(req)), 2)
	})
}

// A Conflicting row that only the forge's flag vouches for can still try
// Update branch, which is how a refusal confirms it. One a refusal named stays
// locked (#3308).
func TestAllowedActions_UpdateBranchOnAnUnconfirmedConflict(t *testing.T) {
	t.Parallel()

	update := func(confirmed *bool) dashboard.ActionAvailability {
		pr := ghPR(func(p *dashboard.PullRequest) {
			p.Forge = dashboard.ForgeForgejo
			p.Behind = true
			p.MergeStatus = dashboard.MergeConflicting
			p.ConflictConfirmed = confirmed
		})
		for _, a := range dashboard.AllowedActions(pr, nil) {
			if a.Action == dashboard.ActionUpdateBranch {
				return a
			}
		}

		return dashboard.ActionAvailability{}
	}
	no, yes := false, true

	assert.Nil(t, update(&no).Blocked)
	require.NotNil(t, update(&yes).Blocked)
	assert.Equal(t, dashboard.ActionConflict, update(&yes).Blocked.Code)
	require.NotNil(t, update(nil).Blocked)
}

// Dependabot refuses `@dependabot rebase` on a branch carrying a commit it
// didn't make ("edited by someone other than Dependabot"), so such a pull
// request offers Update branch, which the forge does for anyone, and Recreate,
// and no Rebase that can only be refused (#4023).
func TestAllowedActions_EditedDependabotBranchUpdatesInsteadOfRebasing(t *testing.T) {
	t.Parallel()

	edited := ghPR(func(p *dashboard.PullRequest) {
		p.Author = "dependabot[bot]"
		p.Behind = true
		p.EditedByOthers = true
	})

	assert.Equal(t, []dashboard.ActionName{dashboard.ActionDependabotRecreate}, dependabotCommands(edited))
	assert.Contains(t, actionNames(edited), dashboard.ActionUpdateBranch)

	t.Run("a branch only Dependabot touched keeps the rebase and no Update branch", func(t *testing.T) {
		t.Parallel()

		plain := ghPR(func(p *dashboard.PullRequest) {
			p.Author = "dependabot[bot]"
			p.Behind = true
		})

		assert.Equal(t, []dashboard.ActionName{dashboard.ActionDependabotRebase, dashboard.ActionDependabotRecreate}, dependabotCommands(plain))
		assert.NotContains(t, actionNames(plain), dashboard.ActionUpdateBranch)
	})

	t.Run("an edited branch that is not behind offers no Update branch", func(t *testing.T) {
		t.Parallel()

		upToDate := ghPR(func(p *dashboard.PullRequest) {
			p.Author = "dependabot[bot]"
			p.EditedByOthers = true
		})

		assert.NotContains(t, actionNames(upToDate), dashboard.ActionUpdateBranch)
	})
}

// While the forge can't be asked, no action can run, and the reason comes from
// the one claim rule (#3994).
func TestAllowedActionsOn_ForgeThatCantBeAsked(t *testing.T) {
	t.Parallel()

	since := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	down := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: false, StaleSince: &since}
	claim := dashboard.ClaimOf(dashboard.ClaimAction, down, true)

	for _, forge := range []dashboard.Forge{dashboard.ForgeGitHub, dashboard.ForgeForgejo} {
		pr := ghPR(func(p *dashboard.PullRequest) { p.Forge = forge; p.Behind = true })
		down.Forge = forge
		actions := dashboard.AllowedActionsOn(pr, nil, down)
		require.NotEmpty(t, actions)
		for _, a := range actions {
			require.NotNil(t, a.Blocked, "%s %s", forge, a.Action)
			assert.Equal(t, dashboard.ActionForgeUnreachable, a.Blocked.Code)
			assert.Equal(t, claim.Reason, a.Blocked.Message)
			assert.Equal(t, claim.Since, a.Blocked.Since)
			assert.False(t, a.Primary)
		}
	}

	t.Run("the claim's reason outranks one the earlier answer had", func(t *testing.T) {
		t.Parallel()

		pr := ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting })
		found := false
		for _, a := range dashboard.AllowedActionsOn(pr, nil, down) {
			if a.Action == dashboard.ActionMerge {
				found = true
				require.NotNil(t, a.Blocked)
				assert.Equal(t, dashboard.ActionForgeUnreachable, a.Blocked.Code)
			}
		}
		assert.True(t, found, "Merge is listed")
	})
	t.Run("a forge that answers changes nothing", func(t *testing.T) {
		t.Parallel()

		pr := ghPR(nil)
		assert.Equal(t, dashboard.AllowedActions(pr, nil), dashboard.AllowedActionsOn(pr, nil, dashboard.ForgeHealth{Reachable: true}))
	})
}
