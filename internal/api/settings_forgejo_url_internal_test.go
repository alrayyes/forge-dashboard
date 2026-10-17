package api

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
)

// A URL stored before credentials were refused must not come back out, over
// GET, PUT or the MCP tool, which all build their answer here.
func TestSettingsResponseOf_ForgejoURLIsShownWithoutCredentials(t *testing.T) {
	t.Parallel()

	for name, c := range map[string]struct{ stored, shown string }{
		"a clean URL is untouched":    {"https://git.example.com/base", "https://git.example.com/base"},
		"empty stays empty":           {"", ""},
		"a username":                  {"https://user@git.example.com", "https://git.example.com"},
		"a username and password":     {"https://user:s3cret@git.example.com/base", "https://git.example.com/base"},
		"a query token":               {"https://git.example.com/base?token=abc", "https://git.example.com/base"},
		"a fragment":                  {"https://git.example.com/base#abc", "https://git.example.com/base"},
		"everything at once":          {"https://u:p@git.example.com:8443/b?t=1#f", "https://git.example.com:8443/b"},
		"an unparseable stored value": {"https://u:p@git.exa mple.com", ""},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got := settingsResponseOf(settings.Credentials{ForgejoURL: c.stored}, false, nil)

			assert.Equal(t, c.shown, got.ForgejoURL)
		})
	}
}
