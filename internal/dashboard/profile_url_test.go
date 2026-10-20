package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func TestWebBase(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name, itemURL, repo, want string
	}{
		{"github item", "https://github.com/alrayyes/app/pull/7", "alrayyes/app", "https://github.com"},
		{"forgejo item on a port", "https://git.example.org:3000/team/app/issues/2", "team/app", "https://git.example.org:3000"},
		{"a forgejo under a path prefix keeps the prefix", "https://host.example.org/forgejo/team/app/pulls/3", "team/app", "https://host.example.org/forgejo"},
		{"a deeper prefix", "https://host.example.org/a/b/team/app/pulls/3", "team/app", "https://host.example.org/a/b"},
		{"the repo is matched without regard to case", "https://git.example.org/Team/App/pulls/3", "team/app", "https://git.example.org"},
		{"plain http is kept", "http://forge.local/x/y/pulls/1", "x/y", "http://forge.local"},
		{"a repo that is not in the address gives no base", "https://git.example.org/other/thing/pulls/3", "team/app", ""},
		{"no repo", "https://github.com/alrayyes/app/pull/7", "", ""},
		{"empty", "", "x/y", ""},
		{"not a url", "not a url", "x/y", ""},
		{"no host", "https:///x/y/pulls/1", "x/y", ""},
		{"a script scheme is refused", "javascript://github.com/x/y/%0Aalert(1)", "x/y", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.want, dashboard.WebBase(tc.itemURL, tc.repo))
		})
	}
}

func TestProfileURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		forge dashboard.Forge
		base  string
		login string
		want  string
	}{
		{"github user", dashboard.ForgeGitHub, "https://github.com", "alrayyes", "https://github.com/alrayyes"},
		{"forgejo user", dashboard.ForgeForgejo, "https://git.example.org", "ryan", "https://git.example.org/ryan"},
		{"a forgejo under a path prefix", dashboard.ForgeForgejo, "https://host.example.org/forgejo", "ryan", "https://host.example.org/forgejo/ryan"},
		// Checked against github.com: /apps/dependabot lands on a docs page,
		// /dependabot is its own organisation page.
		{"dependabot is an organisation page", dashboard.ForgeGitHub, "https://github.com", "dependabot[bot]", "https://github.com/dependabot"},
		{"dependabot's bare GraphQL slug is the same page", dashboard.ForgeGitHub, "https://github.com", "dependabot", "https://github.com/dependabot"},
		// /apps/renovate is the app's own page; /renovate is a 404.
		{"renovate is its app page", dashboard.ForgeGitHub, "https://github.com", "renovate[bot]", "https://github.com/apps/renovate"},
		{"renovate's bare GraphQL slug is the same page", dashboard.ForgeGitHub, "https://github.com", "renovate", "https://github.com/apps/renovate"},
		// Neither /github-actions (404) nor /apps/github-actions (a features
		// page) is a profile: no link beats a dead link.
		{"github-actions has no page to link", dashboard.ForgeGitHub, "https://github.com", "github-actions[bot]", ""},
		{"a bot with no verified page gets no link", dashboard.ForgeGitHub, "https://github.com", "copilot-swe-agent[bot]", ""},
		{"a forgejo user that happens to be called renovate is a user", dashboard.ForgeForgejo, "https://git.example.org", "renovate", "https://git.example.org/renovate"},
		{"a forgejo bot login with brackets is not special", dashboard.ForgeForgejo, "https://git.example.org", "renovate-bot", "https://git.example.org/renovate-bot"},
		{"a deleted account has no page", dashboard.ForgeGitHub, "https://github.com", "ghost", ""},
		{"forgejo's deleted account is spelled Ghost", dashboard.ForgeForgejo, "https://git.example.org", "Ghost", ""},
		{"no login", dashboard.ForgeGitHub, "https://github.com", "", ""},
		{"no base", dashboard.ForgeGitHub, "", "alrayyes", ""},
		{"a login with a slash cannot climb out of the user path", dashboard.ForgeForgejo, "https://git.example.org", "a/../b", ""},
		{"a login is escaped", dashboard.ForgeForgejo, "https://git.example.org", "a b", "https://git.example.org/a%20b"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.want, dashboard.ProfileURL(tc.forge, tc.base, tc.login))
		})
	}
}
