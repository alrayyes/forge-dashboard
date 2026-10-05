package dashboard_test

import (
	"sort"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// summary flattens a pull request's allowed actions to "action" for an
// enabled one and "action:code" for a blocked one, sorted, so a case reads as
// one line of what the page offers.
func summary(pr dashboard.PullRequest) []string {
	out := []string{}
	for _, a := range dashboard.AllowedActions(pr) {
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
		{"empty: merge says nothing to merge", ghPR(func(p *dashboard.PullRequest) { p.Empty = true }), []string{"close", "merge:already_up_to_date"}},
		{"conflicting", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting }), []string{"close", "merge:conflict"}},
		{"conflicting and behind: update branch is locked too", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting; p.Behind = true }), []string{"close", "merge:conflict", "update_branch:conflict"}},
		{"draft that is not mergeable", ghPR(func(p *dashboard.PullRequest) { p.Draft = true; p.MergeStatus = dashboard.MergeBlocked }), []string{"auto_merge", "close", "merge:not_mergeable"}},
		{"draft that GitHub calls clean is still blocked (#957)", ghPR(func(p *dashboard.PullRequest) { p.Draft = true }), []string{"close", "merge:not_mergeable"}},
		{"unstable with a failing optional check still merges (#955)", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnstable; p.CI = dashboard.CIFailure }), []string{"auto_merge", "close", "merge"}},
		{"unstable with an optional check pending still merges (#956)", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnstable; p.CI = dashboard.CIPending }), []string{"auto_merge", "close", "merge"}},
		{"CI pending locks merge even when mergeable", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending }), []string{"auto_merge", "close", "merge:checks_pending"}},
		{"behind and not mergeable", ghPR(func(p *dashboard.PullRequest) { p.Behind = true; p.MergeStatus = dashboard.MergeBlocked }), []string{"auto_merge", "close", "merge:behind", "update_branch"}},
		{"behind but mergeable keeps merge (Forgejo)", ghPR(func(p *dashboard.PullRequest) { p.Forge = dashboard.ForgeForgejo; p.Behind = true }), []string{"close", "merge", "update_branch"}},
		{"blocked with CI failing", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeBlocked; p.CI = dashboard.CIFailure }), []string{"auto_merge", "close", "merge:checks_failing"}},
		{"blocked otherwise", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeBlocked }), []string{"auto_merge", "close", "merge:blocked_by_protection"}},
		{"merge status not known yet", ghPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnknown }), []string{"auto_merge", "close", "merge:not_mergeable"}},
		{"auto-merge already on is not offered again", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending; p.AutoMergeEnabled = new(true) }), []string{"close", "merge:checks_pending"}},
		{"auto-merge refused by the forge for this PR", ghPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending; p.AutoMergeAllowed = new(false) }), []string{"close", "merge:checks_pending"}},
		{"auto-merge is GitHub only", ghPR(func(p *dashboard.PullRequest) { p.Forge = dashboard.ForgeForgejo; p.CI = dashboard.CIPending }), []string{"close", "merge:checks_pending"}},
		{"Dependabot behind on GitHub gets its own rebase, not update branch", ghPR(func(p *dashboard.PullRequest) { p.Author = "dependabot[bot]"; p.Behind = true }), []string{"auto_merge", "close", "dependabot_rebase", "dependabot_recreate", "merge"}},
		{"Dependabot on Forgejo gets no bot commands", ghPR(func(p *dashboard.PullRequest) {
			p.Forge = dashboard.ForgeForgejo
			p.Author = "dependabot"
			p.Behind = true
		}), []string{"close", "merge"}},
		{"Renovate behind gets its rebase on either forge", ghPR(func(p *dashboard.PullRequest) {
			p.Forge = dashboard.ForgeForgejo
			p.Author = "renovate"
			p.Behind = true
		}), []string{"close", "merge", "renovate_rebase"}},
		{"release-please behind keeps update branch", ghPR(func(p *dashboard.PullRequest) {
			p.Behind = true
			p.Labels = []dashboard.Label{{Name: "autorelease: pending"}}
		}), []string{"auto_merge", "close", "merge", "update_branch"}},
		{"stacked on an open parent: merge is blocked and auto-merge is gone", ghPR(func(p *dashboard.PullRequest) { p.StackedOn = &dashboard.StackRef{Number: 840} }), []string{"close", "merge:stacked"}},
		{"stacked beats CI pending as the reason", ghPR(func(p *dashboard.PullRequest) {
			p.StackedOn = &dashboard.StackRef{Number: 840}
			p.CI = dashboard.CIPending
		}), []string{"close", "merge:stacked"}},
		{"empty beats stacked", ghPR(func(p *dashboard.PullRequest) { p.StackedOn = &dashboard.StackRef{Number: 840}; p.Empty = true }), []string{"close", "merge:already_up_to_date"}},
		{"the bottom of a stack merges as usual", ghPR(func(p *dashboard.PullRequest) { p.StackChildren = []int{853} }), []string{"close", "merge"}},
		{"empty and behind: no update branch", ghPR(func(p *dashboard.PullRequest) { p.Empty = true; p.Behind = true }), []string{"close", "merge:already_up_to_date"}},
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
	for _, a := range dashboard.AllowedActions(pr) {
		if a.Action == dashboard.ActionMerge {
			merge = a
		}
	}

	if assert.NotNil(t, merge.Blocked) {
		assert.Equal(t, "Waiting for CI to finish", merge.Blocked.Message)
		assert.Equal(t, "Merge unlocks automatically", merge.Blocked.Next)
	}
}

func TestAllowedActions_StackedMergeNamesTheParent(t *testing.T) {
	t.Parallel()

	pr := ghPR(func(p *dashboard.PullRequest) { p.StackedOn = &dashboard.StackRef{Number: 840} })

	var merge dashboard.ActionAvailability
	for _, a := range dashboard.AllowedActions(pr) {
		if a.Action == dashboard.ActionMerge {
			merge = a
		}
	}

	if assert.NotNil(t, merge.Blocked) {
		assert.Equal(t, "Stacked on #840. Merge that one first.", merge.Blocked.Message)
		assert.Equal(t, "Merge unlocks once #840 merges and this pull request is retargeted.", merge.Blocked.Next)
	}
}
