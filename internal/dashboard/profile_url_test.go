package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func TestWebOrigin(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name, in, want string
	}{
		{"github item", "https://github.com/alrayyes/app/pull/7", "https://github.com"},
		{"forgejo item on a port", "https://git.example.org:3000/team/app/issues/2", "https://git.example.org:3000"},
		{"plain http is kept", "http://forge.local/x/y/pulls/1", "http://forge.local"},
		{"empty", "", ""},
		{"not a url", "not a url", ""},
		{"no host", "https:///x", ""},
		{"a script scheme is refused", "javascript://github.com/%0Aalert(1)", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.want, dashboard.WebOrigin(tc.in))
		})
	}
}

func TestProfileURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		forge  dashboard.Forge
		origin string
		login  string
		want   string
	}{
		{"github user", dashboard.ForgeGitHub, "https://github.com", "alrayyes", "https://github.com/alrayyes"},
		{"forgejo user", dashboard.ForgeForgejo, "https://git.example.org", "ryan", "https://git.example.org/ryan"},
		{"a REST bot login is an app page", dashboard.ForgeGitHub, "https://github.com", "dependabot[bot]", "https://github.com/apps/dependabot"},
		{"a GraphQL bot slug is an app page", dashboard.ForgeGitHub, "https://github.com", "dependabot", "https://github.com/apps/dependabot"},
		{"renovate on github is an app page", dashboard.ForgeGitHub, "https://github.com", "renovate", "https://github.com/apps/renovate"},
		{"a forgejo user that happens to be called renovate is a user", dashboard.ForgeForgejo, "https://git.example.org", "renovate", "https://git.example.org/renovate"},
		{"a deleted account has no page", dashboard.ForgeGitHub, "https://github.com", "ghost", ""},
		{"no login", dashboard.ForgeGitHub, "https://github.com", "", ""},
		{"no origin", dashboard.ForgeGitHub, "", "alrayyes", ""},
		{"a login with a slash cannot climb out of the user path", dashboard.ForgeForgejo, "https://git.example.org", "a/../b", ""},
		{"a login is escaped", dashboard.ForgeForgejo, "https://git.example.org", "a b", "https://git.example.org/a%20b"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.want, dashboard.ProfileURL(tc.forge, tc.origin, tc.login))
		})
	}
}
