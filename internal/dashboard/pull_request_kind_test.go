package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// One place decides what kind of pull request this is (#716), so the page and
// every other client stop keeping their own copy of the rule.
func TestKindOf(t *testing.T) {
	t.Parallel()

	release := []dashboard.Label{{Name: "autorelease: pending"}}
	tagged := []dashboard.Label{{Name: "autorelease: tagged"}}

	cases := []struct {
		name string
		pr   dashboard.PullRequest
		want dashboard.PullRequestKind
	}{
		{"a human's pull request", dashboard.PullRequest{Author: "alice"}, dashboard.KindRegular},
		{"no author at all", dashboard.PullRequest{}, dashboard.KindRegular},
		{"release-please's pending release", dashboard.PullRequest{Author: "alice", Labels: release}, dashboard.KindRelease},
		{"release-please's tagged release", dashboard.PullRequest{Author: "alice", Labels: tagged}, dashboard.KindRelease},
		{"Dependabot as GraphQL names it", dashboard.PullRequest{Author: "dependabot"}, dashboard.KindDependency},
		{"Dependabot as REST names it", dashboard.PullRequest{Author: "dependabot[bot]"}, dashboard.KindDependency},
		{"Renovate as GraphQL names it", dashboard.PullRequest{Author: "renovate"}, dashboard.KindDependency},
		{"Renovate as REST names it", dashboard.PullRequest{Author: "renovate[bot]"}, dashboard.KindDependency},
		{"Renovate on Forgejo", dashboard.PullRequest{Forge: dashboard.ForgeForgejo, Author: "renovate"}, dashboard.KindDependency},
		{"a release label beats a bot author", dashboard.PullRequest{Author: "dependabot[bot]", Labels: release}, dashboard.KindRelease},
		{"an unrelated label changes nothing", dashboard.PullRequest{Author: "alice", Labels: []dashboard.Label{{Name: "bug"}}}, dashboard.KindRegular},
		{"Renovate's Forgejo account, no setting changed", dashboard.PullRequest{Forge: dashboard.ForgeForgejo, Author: "renovatebot"}, dashboard.KindDependency},
		{"Renovate's account in another case", dashboard.PullRequest{Author: "RenovateBot"}, dashboard.KindDependency},
		{"a renovate/ branch, unknown author", dashboard.PullRequest{Author: "mend-bot", HeadBranch: "renovate/lodash-4.x"}, dashboard.KindDependency},
		{"a renovate/ branch on GitHub", dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Author: "alice", HeadBranch: "renovate/configure"}, dashboard.KindDependency},
		{"a human branch that merely mentions renovate", dashboard.PullRequest{Author: "alice", HeadBranch: "fix/renovate-config"}, dashboard.KindRegular},
		{"a branch with renovate/ not at the start", dashboard.PullRequest{Author: "alice", HeadBranch: "feat/renovate/x"}, dashboard.KindRegular},
		{"a release label beats a renovate/ branch", dashboard.PullRequest{Author: "alice", HeadBranch: "renovate/x", Labels: release}, dashboard.KindRelease},
		{"a release label beats renovatebot", dashboard.PullRequest{Author: "renovatebot", Labels: release}, dashboard.KindRelease},
		{"a lookalike author is a person", dashboard.PullRequest{Author: "dependabot-fan"}, dashboard.KindRegular},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.want, dashboard.KindOf(tc.pr, nil))
		})
	}
}

func TestKindOf_ConfiguredRenovateAuthorIsADependency(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{Forge: dashboard.ForgeForgejo, Author: "mend-bot"}

	assert.Equal(t, dashboard.KindRegular, dashboard.KindOf(pr, nil))
	assert.Equal(t, dashboard.KindDependency, dashboard.KindOf(pr, []string{"mend-bot"}))
}

// The allowed actions share the one rule, so a renovate/ branch gets Renovate's
// Rebase and no Update branch.
func TestAllowedActions_RenovateBranchIsTreatedAsRenovate(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{Forge: dashboard.ForgeForgejo, Author: "mend-bot", HeadBranch: "renovate/lodash-4.x", Behind: true}

	names := []dashboard.ActionName{}
	for _, a := range dashboard.AllowedActions(pr, nil) {
		names = append(names, a.Action)
	}

	assert.Contains(t, names, dashboard.ActionRenovateRebase)
	assert.NotContains(t, names, dashboard.ActionUpdateBranch)
}
