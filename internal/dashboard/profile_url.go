package dashboard

import (
	"net/url"
	"strings"
)

// githubApps are the bot accounts GitHub's GraphQL answers with a bare slug
// (no "[bot]" suffix), whose pages live under /apps/<slug>, not /<login>.
// Only consulted for GitHub: a Forgejo user may well be called "renovate".
var githubApps = map[string]bool{"dependabot": true, "renovate": true}

// WebOrigin is the scheme and host of a forge item's own web URL, the part a
// profile page shares with it. Empty for anything that isn't an http or https
// URL with a host, so a hostile or malformed value never becomes a link.
func WebOrigin(itemURL string) string {
	u, err := url.Parse(itemURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return ""
	}

	return u.Scheme + "://" + u.Host
}

// ProfileURL is the forge's page for login, built on origin (a WebOrigin).
// Empty when there is nothing sensible to link to: no login, GitHub's "ghost"
// for a deleted account, no origin, or a login that is not one path segment.
// A GitHub bot (a "[bot]" suffix, or one of the known app slugs) links to its
// /apps page, since /<login> would be a 404.
func ProfileURL(forge Forge, origin, login string) string {
	if login == "" || login == "ghost" || origin == "" {
		return ""
	}
	if strings.ContainsAny(login, "/\\?#") {
		return ""
	}
	if forge == ForgeGitHub {
		slug := strings.TrimSuffix(login, "[bot]")
		if slug != login || githubApps[login] {
			return origin + "/apps/" + url.PathEscape(slug)
		}
	}

	return origin + "/" + url.PathEscape(login)
}
