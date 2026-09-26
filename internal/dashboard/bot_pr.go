package dashboard

import "strings"

// DependabotRebaseComment and DependabotRecreateComment are Dependabot's own
// documented PR-comment commands (docs.github.com/en/code-security/
// dependabot/working-with-dependabot/managing-pull-requests-for-dependency-
// updates) — the single source of truth for the exact text, shared by the
// manual dependabot-action API handler and the auto-update-branch hook
// (auto_update_branch.go) so the two can't drift apart.
const (
	DependabotRebaseComment   = "@dependabot rebase"
	DependabotRecreateComment = "@dependabot recreate"
)

// release-please labels every PR it manages with "autorelease: pending"
// or "autorelease: tagged" — the author is a human in this account's
// setup, not release-please itself, so the label is the only signal.
func isReleasePleasePR(pr PullRequest) bool {
	for _, l := range pr.Labels {
		if strings.HasPrefix(l.Name, "autorelease:") {
			return true
		}
	}

	return false
}

// A GitHub App actor's login comes back in two different shapes depending
// on which API served it: GraphQL's Actor.login is the bare app slug
// ("dependabot", confirmed live via `gh api graphql` against a real
// Dependabot PR — the "app/dependabot" form is gh CLI's own display
// convention for a Bot actor, never a raw API value), while the REST
// pulls/issues endpoints append "[bot]" to the same slug ("dependabot[bot]")
// the way they do for every GitHub App. This client's own two fetch paths
// (client.go's GraphQL query vs. its unauthenticated-mode REST fallback)
// produce exactly these two forms, so both need matching — checking only
// "app/dependabot", a form neither path ever actually returns, left this
// false unconditionally (#522).
func isDependabotPR(pr PullRequest) bool {
	return pr.Author == "dependabot" || pr.Author == "dependabot[bot]"
}

// Same GraphQL-bare-slug-vs-REST-"[bot]"-suffix split as isDependabotPR,
// for Renovate's own GitHub App install.
func isRenovatePR(pr PullRequest) bool {
	return pr.Author == "renovate" || pr.Author == "renovate[bot]"
}
