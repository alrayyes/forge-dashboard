package dashboard

import "strings"

// IsBotManagedPR reports whether pr is opened and kept up to date by one
// of the release/dependency bots this account runs — release-please,
// Dependabot, Renovate — the Go-side port of +page.svelte's own
// isBotManagedPr, needed here too because the background refresh loop
// that drives auto-update-branch (#365) has no frontend button to
// suppress the way a manual click already does.
func IsBotManagedPR(pr PullRequest) bool {
	return isReleasePleasePR(pr) || isDependabotPR(pr) || isRenovatePR(pr)
}

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

// Dependabot's author login is its GitHub App identity, "app/dependabot"
// — not "dependabot[bot]", which is the older, now-secondary identity.
func isDependabotPR(pr PullRequest) bool {
	return pr.Author == "app/dependabot"
}

// Renovate's author login varies by how it's installed (a GitHub App vs.
// a classic bot account) — checking both forms this account has seen
// documented, rather than picking one and risking silent non-detection.
func isRenovatePR(pr PullRequest) bool {
	return pr.Author == "renovate[bot]" || pr.Author == "app/renovate"
}
