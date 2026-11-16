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

func TestClaimOfRow(t *testing.T) {
	since := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	kinds := []dashboard.ClaimKind{dashboard.ClaimConflict, dashboard.ClaimState, dashboard.ClaimAction}
	for _, kind := range kinds {
		t.Run(string(kind), func(t *testing.T) {
			c := dashboard.ClaimOfRow(kind, nil)
			assert.Equal(t, dashboard.ClaimConfirmed, c.State)
			assert.True(t, c.ActionsOpen)
			assert.Nil(t, c.Since)
			assert.Empty(t, c.Reason)

			c = dashboard.ClaimOfRow(kind, &since)
			assert.Equal(t, dashboard.ClaimCarriedOver, c.State)
			assert.False(t, c.ActionsOpen)
			assert.Equal(t, &since, c.Since)
			assert.NotEmpty(t, c.Reason)
		})
	}

	t.Run("reads the same as a forge that can't be asked", func(t *testing.T) {
		down := dashboard.ClaimOf(dashboard.ClaimState, dashboard.ForgeHealth{StaleSince: &since}, true)
		row := dashboard.ClaimOfRow(dashboard.ClaimState, &since)
		assert.Equal(t, down, row)
	})
}

// The web's rowClaim (web/src/lib/row-claim.ts) says the same words for a
// carried-over row with no since-time; its test pins the same sentence.
const carriedOverWords = "Showing data. The forge isn't answering yet, so this may be an earlier answer, and no action can run until it does."

func TestClaimOf_CarriedOverReadsAsTheWebDoes(t *testing.T) {
	c := dashboard.ClaimOf(dashboard.ClaimState, dashboard.ForgeHealth{Reachable: false}, true)
	assert.Equal(t, carriedOverWords, c.Reason)
}

func TestForgeHealthOf(t *testing.T) {
	since := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	down := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, StaleSince: &since}
	up := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}
	other := dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo}
	starting := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Starting: true, StaleSince: &since}

	assert.Equal(t, down, dashboard.ForgeHealthOf([]dashboard.ForgeHealth{down, other}, dashboard.ForgeGitHub))
	assert.Equal(t, up, dashboard.ForgeHealthOf([]dashboard.ForgeHealth{down, up}, dashboard.ForgeGitHub), "a host that answers keeps the row's claim open")
	assert.Equal(t, starting, dashboard.ForgeHealthOf([]dashboard.ForgeHealth{starting, other}, dashboard.ForgeGitHub), "a host that has not been asked yet is an earlier answer")
	assert.Equal(t, up, dashboard.ForgeHealthOf([]dashboard.ForgeHealth{starting, up}, dashboard.ForgeGitHub), "a host that answers outranks one that is starting")
	assert.Equal(t, starting, dashboard.ForgeHealthOf([]dashboard.ForgeHealth{starting, down}, dashboard.ForgeGitHub), "with none answering the first host speaks for the kind")
	assert.True(t, dashboard.ForgeHealthOf(nil, dashboard.ForgeGitHub).Reachable, "no entry says nothing against a row")
}
