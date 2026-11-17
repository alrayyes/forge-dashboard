package dashboard

import (
	"net/url"
	"strings"
)

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
// path segment. A bot account (BotLoginSuffix) has a page only where the forge's
// BotProfilePages says so.
func ProfileURL(forge Forge, base, login string) string {
	c, _ := CapabilitiesOf(forge)

	return profileURLFor(c, base, login)
}

// profileURLFor is ProfileURL for a forge's already-resolved capabilities.
func profileURLFor(c ForgeCapabilities, base, login string) string {
	if login == "" || strings.EqualFold(login, "ghost") || base == "" {
		return ""
	}
	if strings.ContainsAny(login, "/\\?#") {
		return ""
	}
	slug := login
	if c.BotLoginSuffix != "" {
		slug = strings.TrimSuffix(login, c.BotLoginSuffix)
	}
	if page, ok := c.BotProfilePages[slug]; ok {
		return base + "/" + page
	}
	if slug != login {
		return ""
	}

	return base + "/" + url.PathEscape(login)
}
