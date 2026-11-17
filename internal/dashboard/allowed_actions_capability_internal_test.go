package dashboard

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestAllowedActions_DependabotCommandsFollowTheCapabilityNotTheForgeName(t *testing.T) {
	// Not parallel: it edits the shared capability table.
	listens := Forge("listenforge")
	deaf := Forge("deafforge")
	withForge(t, listens, ForgeCapabilities{DependabotCommands: true})
	withForge(t, deaf, ForgeCapabilities{DependabotCommands: false})

	names := func(f Forge) []ActionName {
		pr := PullRequest{Forge: f, Repo: "o/a", Number: 1, Author: "dependabot[bot]"}
		var out []ActionName
		for _, a := range AllowedActions(pr, nil) {
			out = append(out, a.Action)
		}

		return out
	}

	assert.Contains(t, names(listens), ActionDependabotRecreate)
	assert.NotContains(t, names(deaf), ActionDependabotRecreate)
	assert.NotContains(t, names(deaf), ActionDependabotRebase)
}
