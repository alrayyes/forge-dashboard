package dashboard_test

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClaimOf(t *testing.T) {
	since := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	answered := dashboard.ForgeHealth{Reachable: true}
	down := dashboard.ForgeHealth{Reachable: false, StaleSince: &since}
	starting := dashboard.ForgeHealth{Starting: true, StaleSince: &since}

	kinds := []dashboard.ClaimKind{dashboard.ClaimConflict, dashboard.ClaimState, dashboard.ClaimAction}
	for _, kind := range kinds {
		t.Run(string(kind), func(t *testing.T) {
			c := dashboard.ClaimOf(kind, answered, true)
			assert.Equal(t, dashboard.ClaimConfirmed, c.State)
			assert.True(t, c.ActionsOpen)
			assert.Empty(t, c.Reason)

			for name, h := range map[string]dashboard.ForgeHealth{"unreachable": down, "starting": starting} {
				c = dashboard.ClaimOf(kind, h, true)
				assert.Equal(t, dashboard.ClaimCarriedOver, c.State, name)
				assert.False(t, c.ActionsOpen, name)
				assert.NotEmpty(t, c.Reason, name)
				assert.NotNil(t, c.Since, name)
			}
		})
	}

	t.Run("an unconfirmed conflict is unknown", func(t *testing.T) {
		c := dashboard.ClaimOf(dashboard.ClaimConflict, answered, false)
		assert.Equal(t, dashboard.ClaimUnknown, c.State)
		assert.NotEmpty(t, c.Reason)
	})
	t.Run("other kinds ignore answered", func(t *testing.T) {
		assert.Equal(t, dashboard.ClaimConfirmed, dashboard.ClaimOf(dashboard.ClaimState, answered, false).State)
	})
	t.Run("carried over wins over unknown", func(t *testing.T) {
		assert.Equal(t, dashboard.ClaimCarriedOver, dashboard.ClaimOf(dashboard.ClaimConflict, down, false).State)
	})
	t.Run("names no forge", func(t *testing.T) {
		src, err := os.ReadFile("row_claim.go")
		require.NoError(t, err)
		lower := strings.ToLower(string(src))
		assert.NotContains(t, lower, "forgejo")
		assert.NotContains(t, lower, "github")
	})
}
