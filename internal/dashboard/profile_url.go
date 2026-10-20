package dashboard

import (
	"net/url"
	"strings"
)

// githubBotPages are the GitHub bots whose page was checked to exist, by the
// slug without any "[bot]" suffix. A bot's login is not its page: Dependabot's
// is an organisation at /dependabot (/apps/dependabot only lands on a docs
// page), Renovate's is its app page (/renovate is a 404). GitHub Actions and
// the rest have no page that is theirs, and a missing link beats a dead one,
// so a bot not listed here is shown by name alone.
var githubBotPages = map[string]string{
	"dependabot": "dependabot",
	"renovate":   "apps/renovate",
}

// WebBase is the web address a forge's profile pages hang off, taken from one
// of its own items: the item's URL up to the "/owner/repo/" part. That keeps a
// path prefix a self-hosted forge may sit under (https://host/forgejo), which a
// scheme-and-host cut would lose. Empty when itemURL isn't an http or https
// URL with a host, or doesn't contain the repo, so a malformed or hostile
// value never becomes a link.
func WebBase(itemURL, repo string) string {
	u, err := url.Parse(itemURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || repo == "" {
		return ""
	}
	i := strings.Index(strings.ToLower(u.Path), "/"+strings.ToLower(repo)+"/")
	if i < 0 {
		return ""
	}

	return u.Scheme + "://" + u.Host + u.Path[:i]
}

// ProfileURL is the forge's page for login, built on base (a WebBase). Empty
// when there is nothing sensible to link to: no login, a deleted account
// (GitHub's "ghost", Forgejo's "Ghost"), no base, or a login that is not one
// path segment. A GitHub bot has a page only where githubBotPages says so.
func ProfileURL(forge Forge, base, login string) string {
	if login == "" || strings.EqualFold(login, "ghost") || base == "" {
		return ""
	}
	if strings.ContainsAny(login, "/\\?#") {
		return ""
	}
	if forge == ForgeGitHub {
		slug := strings.TrimSuffix(login, "[bot]")
		if page, ok := githubBotPages[slug]; ok {
			return base + "/" + page
		}
		if slug != login {
			return ""
		}
	}

	return base + "/" + url.PathEscape(login)
}
