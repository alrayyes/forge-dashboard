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
		{"a lookalike author is a person", dashboard.PullRequest{Author: "dependabot-fan"}, dashboard.KindRegular},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.want, dashboard.KindOf(tc.pr))
		})
	}
}
