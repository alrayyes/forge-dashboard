package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func reference(repo string, number int, relation dashboard.ReferenceRelation) dashboard.ItemReference {
	return dashboard.ItemReference{
		Forge: dashboard.ForgeGitHub, Repo: repo, Number: number,
		Direction: dashboard.ReferenceIncoming, Relation: relation,
	}
}

func TestNewestFirstReferences_ListsOneEntryPerItemNewestFirstClosingWins(t *testing.T) {
	t.Parallel()

	got := dashboard.NewestFirstReferences([]dashboard.ItemReference{
		reference("a/b", 1, dashboard.RelationCloses),
		reference("a/b", 2, dashboard.RelationMentions),
		reference("A/B", 1, dashboard.RelationMentions),
	})

	require.Len(t, got, 2)
	assert.Equal(t, 1, got[0].Number, "the newest mention of #1 places it first")
	assert.Equal(t, dashboard.RelationCloses, got[0].Relation, "an older closing event still makes it a close")
	assert.Equal(t, 2, got[1].Number)
	assert.Equal(t, dashboard.RelationMentions, got[1].Relation)
}

func TestNewestFirstReferences_KeepsTheNewestFifty(t *testing.T) {
	t.Parallel()

	var all []dashboard.ItemReference
	for n := 1; n <= dashboard.MaxReferences+5; n++ {
		all = append(all, reference("a/b", n, dashboard.RelationMentions))
	}

	got := dashboard.NewestFirstReferences(all)

	require.Len(t, got, dashboard.MaxReferences)
	assert.Equal(t, dashboard.MaxReferences+5, got[0].Number)
}

func TestNewestFirstReferences_NothingIsNil(t *testing.T) {
	t.Parallel()

	assert.Empty(t, dashboard.NewestFirstReferences(nil))
}
