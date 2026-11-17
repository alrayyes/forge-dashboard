package dashboard

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// A forge with bot accounts of its own resolves its own pages, from the
// capabilities value alone, without a branch on its name.
func TestProfileURLFor_UsesTheForgesOwnBotTable(t *testing.T) {
	t.Parallel()

	caps := ForgeCapabilities{
		BotLoginSuffix:  "-bot",
		BotProfilePages: map[string]string{"helper": "robots/helper"},
	}

	assert.Equal(t, "https://x.test/robots/helper", profileURLFor(caps, "https://x.test", "helper-bot"))
	assert.Equal(t, "https://x.test/robots/helper", profileURLFor(caps, "https://x.test", "helper"))
	assert.Empty(t, profileURLFor(caps, "https://x.test", "other-bot"))
	assert.Equal(t, "https://x.test/alice", profileURLFor(caps, "https://x.test", "alice"))
}

func TestProfileURLFor_AForgeWithoutBotAccountsLinksEveryLogin(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "https://x.test/a%5Bbot%5D", profileURLFor(ForgeCapabilities{}, "https://x.test", "a[bot]"))
}

func TestProfileURL_AnUnknownForgeLinksTheLoginAsIs(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "https://x.test/bob", ProfileURL(Forge("gitea"), "https://x.test", "bob"))
}
