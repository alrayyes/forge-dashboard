package dashboard_test

import (
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func TestCapText_CutsOnACharacterNotAByte(t *testing.T) {
	t.Parallel()

	got, truncated := dashboard.CapText("héllo wörld", 5)

	assert.Equal(t, "héllo", got, "five characters, not five bytes")
	assert.True(t, truncated)
}

func TestCapText_LeavesAShortTextAlone(t *testing.T) {
	t.Parallel()

	long := strings.Repeat("x", dashboard.MaxDetailsBodyRunes)

	got, truncated := dashboard.CapText(long, dashboard.MaxDetailsBodyRunes)

	assert.Equal(t, long, got)
	assert.False(t, truncated, "exactly at the cap is not cut")
}

func TestCapLogins_KeepsTheFirstTenAndNeverReturnsNil(t *testing.T) {
	t.Parallel()

	var twelve []string
	for i := range 12 {
		twelve = append(twelve, string(rune('a'+i)))
	}

	assert.Len(t, dashboard.CapLogins(twelve), dashboard.MaxReactionLogins)
	assert.Equal(t, []string{}, dashboard.CapLogins(nil), "a JSON array, never null")
}

func TestDetailsCaps_AreTheDocumentedNumbers(t *testing.T) {
	t.Parallel()

	assert.Equal(t, 20000, dashboard.MaxDetailsBodyRunes)
	assert.Equal(t, 50, dashboard.MaxDetailsComments)
	assert.Equal(t, 10, dashboard.MaxReactionLogins)
}
