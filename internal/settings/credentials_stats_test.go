package settings_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
)

func TestCredentials_StatsCredentials(t *testing.T) {
	t.Parallel()

	t.Run("a token and an app installation on GitHub, a token on Forgejo", func(t *testing.T) {
		t.Parallel()

		c := settings.Credentials{GitHubToken: "ghp_secret", GitHubAppInstallationID: 7, ForgejoURL: "https://git.example", ForgejoToken: "fj_secret"}

		assert.ElementsMatch(t, []apistats.CredentialRef{
			{Forge: "github", Credential: apistats.AppCredential(7)},
			{Forge: "github", Credential: apistats.TokenCredential("ghp_secret")},
			{Forge: "forgejo", Credential: apistats.TokenCredential("fj_secret")},
		}, c.StatsCredentials())
	})

	t.Run("a public username alone", func(t *testing.T) {
		t.Parallel()

		c := settings.Credentials{GitHubUsername: "alrayyes"}

		assert.Equal(t, []apistats.CredentialRef{{Forge: "github", Credential: apistats.AccountCredential("alrayyes")}}, c.StatsCredentials())
	})

	t.Run("nothing configured", func(t *testing.T) {
		t.Parallel()

		assert.Empty(t, settings.Credentials{}.StatsCredentials())
	})

	t.Run("no label carries a secret", func(t *testing.T) {
		t.Parallel()

		for _, ref := range (settings.Credentials{GitHubToken: "ghp_secret", ForgejoURL: "https://x", ForgejoToken: "fj_secret"}).StatsCredentials() {
			assert.NotContains(t, ref.Credential, "secret")
		}
	})
}
