package dashboard

import (
	"slices"
	"strings"
)

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
// for Renovate's own GitHub App install. A Forgejo or GitLab instance has no
// App: Renovate runs there as an ordinary account with whatever name the
// instance gave it, so the user lists those logins in Settings (#1062) and
// they arrive here as authors. Forge logins aren't case sensitive.
func isRenovatePR(pr PullRequest, authors []string) bool {
	if pr.Author == "renovate" || pr.Author == "renovate[bot]" {
		return true
	}

	return pr.Author != "" && slices.ContainsFunc(authors, func(a string) bool {
		return strings.EqualFold(a, pr.Author)
	})
}

// PullRequestKind is what sort of pull request this is. Matches
// components.schemas.PullRequest.kind.
type PullRequestKind string

// The kinds a pull request can be.
const (
	KindRelease    PullRequestKind = "release"
	KindDependency PullRequestKind = "dependency"
	KindRegular    PullRequestKind = "regular"
)

// KindOf is the one place that decides a pull request's kind (#716), from the
// same release-please and bot-author rules the allowed actions and the
// auto-update pass use. A release label wins: it is the only signal for
// release-please's pull requests, and it is a stronger statement than an
// author.
func KindOf(pr PullRequest, renovateAuthors []string) PullRequestKind {
	switch {
	case isReleasePleasePR(pr):
		return KindRelease
	case isDependabotPR(pr), isRenovatePR(pr, renovateAuthors):
		return KindDependency
	default:
		return KindRegular
	}
}
