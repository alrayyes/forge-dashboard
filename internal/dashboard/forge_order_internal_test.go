package dashboard

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// A forge added to capabilitiesByForge alone, or to knownForges alone, fails here.
func TestForges_MatchTheCapabilityTable(t *testing.T) {
	t.Parallel()

	table := make([]Forge, 0, len(capabilitiesByForge))
	for f := range capabilitiesByForge {
		table = append(table, f)
	}

	assert.ElementsMatch(t, table, Forges())
}
