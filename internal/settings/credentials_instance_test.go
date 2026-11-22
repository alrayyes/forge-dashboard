package settings_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
)

// A self-hosted forge's own instance and token are read by forge name, so
// code that loads from it never names a forge's field (#4574).
func TestCredentials_InstanceFor_IsKeyedByForge(t *testing.T) {
	t.Parallel()
	creds := settings.Credentials{
		ForgejoURL:   "https://forgejo.example",
		ForgejoToken: "fj",
		Instances: map[string]settings.Instance{
			"third": {URL: "https://third.example", Token: "tt"},
		},
	}

	got, ok := creds.InstanceFor("forgejo")
	assert.True(t, ok)
	assert.Equal(t, settings.Instance{URL: "https://forgejo.example", Token: "fj"}, got)

	got, ok = creds.InstanceFor("third")
	assert.True(t, ok)
	assert.Equal(t, settings.Instance{URL: "https://third.example", Token: "tt"}, got)

	_, ok = creds.InstanceFor("github")
	assert.False(t, ok)
	_, ok = settings.Credentials{}.InstanceFor("forgejo")
	assert.False(t, ok, "no saved instance is no instance")
}
