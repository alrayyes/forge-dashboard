package dashboard_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// echoResolver answers every target as an open issue titled by its number, and
// remembers what it was asked.
func echoResolver(asked *[]dashboard.OutgoingTarget) dashboard.OutgoingResolver {
	return func(_ context.Context, targets []dashboard.OutgoingTarget) []dashboard.ItemReference {
		*asked = append(*asked, targets...)
		var out []dashboard.ItemReference
		for _, target := range targets {
			out = append(out, dashboard.ItemReference{
				Forge: dashboard.ForgeGitHub, Repo: target.Repo, Number: target.Number, Title: fmt.Sprintf("Item %d", target.Number),
				URL: target.URL, Kind: dashboard.ItemKindIssue, State: dashboard.ReferencedStateOpen,
			})
		}

		return out
	}
}

func outgoing(t *testing.T, kind dashboard.ItemKind, title, body string, resolve dashboard.OutgoingResolver) []dashboard.ItemReference {
	t.Helper()

	return dashboard.OutgoingReferences(t.Context(), dashboard.ForgeGitHub, kind, title, body, "alrayyes/a", 7, "https://github.com", resolve)
}

func TestOutgoingReferences_AnIssueReferencesAndMentions(t *testing.T) {
	t.Parallel()

	var asked []dashboard.OutgoingTarget
	got := outgoing(t, dashboard.ItemKindIssue, "Title", "Refs #4271, #4297\n\nAlso see alrayyes/b#5 and mind #9.", echoResolver(&asked))

	require.Len(t, got, 4)
	assert.Equal(t, []int{4271, 4297, 5, 9}, []int{got[0].Number, got[1].Number, got[2].Number, got[3].Number})
	assert.Equal(t, dashboard.RelationRefs, got[0].Relation)
	assert.Equal(t, dashboard.RelationRefs, got[1].Relation)
	assert.Equal(t, dashboard.RelationRefs, got[2].Relation)
	assert.Equal(t, dashboard.RelationMentions, got[3].Relation)
	assert.Equal(t, "alrayyes/b", got[2].Repo)
	for _, ref := range got {
		assert.Equal(t, dashboard.ReferenceOutgoing, ref.Direction)
	}
}

// A closing keyword closes nothing on an issue, so it is a mention there.
func TestOutgoingReferences_AnIssueClosesNothing(t *testing.T) {
	t.Parallel()

	var asked []dashboard.OutgoingTarget
	got := outgoing(t, dashboard.ItemKindIssue, "T", "Closes #3", echoResolver(&asked))

	require.Len(t, got, 1)
	assert.Equal(t, dashboard.RelationMentions, got[0].Relation)
}

func TestOutgoingReferences_APullRequestClosesFirstThenRefsThenMentions(t *testing.T) {
	t.Parallel()

	var asked []dashboard.OutgoingTarget
	got := outgoing(t, dashboard.ItemKindPullRequest, "T", "Mentions #9. Refs #8. Closes #7a is no ref, Closes #6.", echoResolver(&asked))

	var relations []dashboard.ReferenceRelation
	var numbers []int
	for _, ref := range got {
		relations = append(relations, ref.Relation)
		numbers = append(numbers, ref.Number)
	}
	assert.Equal(t, []int{6, 8, 9}, numbers)
	assert.Equal(t, []dashboard.ReferenceRelation{dashboard.RelationCloses, dashboard.RelationRefs, dashboard.RelationMentions}, relations)
}

func TestOutgoingReferences_NeverNamesTheItemItself(t *testing.T) {
	t.Parallel()

	var asked []dashboard.OutgoingTarget
	got := outgoing(t, dashboard.ItemKindIssue, "T", "See #7 and #8", echoResolver(&asked))

	require.Len(t, got, 1)
	assert.Equal(t, 8, got[0].Number)
}

func TestOutgoingReferences_StopsAtTheCap(t *testing.T) {
	t.Parallel()

	body := ""
	for n := 100; n < 100+dashboard.MaxOutgoingReferences+5; n++ {
		body += fmt.Sprintf("#%d ", n)
	}
	var asked []dashboard.OutgoingTarget
	got := outgoing(t, dashboard.ItemKindIssue, "T", body, echoResolver(&asked))

	assert.Len(t, got, dashboard.MaxOutgoingReferences)
	assert.Len(t, asked, dashboard.MaxOutgoingReferences, "only the kept ones are looked up")
	assert.Equal(t, 100, got[0].Number, "in the order the text names them")
}

func TestOutgoingReferences_NothingNamedAsksNothing(t *testing.T) {
	t.Parallel()

	called := false
	got := outgoing(t, dashboard.ItemKindIssue, "T", "No references here.", func(context.Context, []dashboard.OutgoingTarget) []dashboard.ItemReference {
		called = true

		return nil
	})

	assert.False(t, called, "no lookup for an empty list")
	assert.Empty(t, got)
	assert.NotNil(t, got, "never nil")
}

// A target the forge can't show (deleted, no access) is left out, and the rest stay.
func TestOutgoingReferences_AnUnresolvedTargetIsLeftOut(t *testing.T) {
	t.Parallel()

	got := outgoing(t, dashboard.ItemKindIssue, "T", "See #8, #9", func(_ context.Context, targets []dashboard.OutgoingTarget) []dashboard.ItemReference {
		return []dashboard.ItemReference{{Forge: dashboard.ForgeGitHub, Repo: targets[1].Repo, Number: targets[1].Number, Title: "Nine"}}
	})

	require.Len(t, got, 1)
	assert.Equal(t, 9, got[0].Number)
	assert.Equal(t, dashboard.RelationRefs, got[0].Relation, "the relation comes from the text, not the resolver")
}

// The text's order is the reader's, however the forge answered.
func TestOutgoingReferences_KeepsTheOrderOfTheText(t *testing.T) {
	t.Parallel()

	got := outgoing(t, dashboard.ItemKindIssue, "T", "See #8, #9", func(_ context.Context, targets []dashboard.OutgoingTarget) []dashboard.ItemReference {
		return []dashboard.ItemReference{
			{Forge: dashboard.ForgeGitHub, Repo: "ALRAYYES/a", Number: 9},
			{Forge: dashboard.ForgeGitHub, Repo: targets[0].Repo, Number: 8},
		}
	})

	require.Len(t, got, 2)
	assert.Equal(t, []int{8, 9}, []int{got[0].Number, got[1].Number})
}

// The cap counts across the relations, not within each.
func TestOutgoingReferences_TheCapHoldsAcrossRelations(t *testing.T) {
	t.Parallel()

	body := "Refs "
	for n := 100; n < 115; n++ {
		body += fmt.Sprintf("#%d, ", n)
	}
	body += "\n\n"
	for n := 200; n < 215; n++ {
		body += fmt.Sprintf("#%d ", n)
	}
	var asked []dashboard.OutgoingTarget
	got := outgoing(t, dashboard.ItemKindIssue, "T", body, echoResolver(&asked))

	assert.Len(t, got, dashboard.MaxOutgoingReferences)
	assert.Equal(t, dashboard.RelationRefs, got[0].Relation, "references fill the cap before mentions")
	assert.Equal(t, dashboard.RelationMentions, got[len(got)-1].Relation)
}

// One item is one entry, under the strongest relation.
func TestOutgoingReferences_AClosedItemIsNotAlsoReferenced(t *testing.T) {
	t.Parallel()

	var asked []dashboard.OutgoingTarget
	got := outgoing(t, dashboard.ItemKindPullRequest, "T", "Closes #6\n\nRefs #6", echoResolver(&asked))

	require.Len(t, got, 1)
	assert.Equal(t, dashboard.RelationCloses, got[0].Relation)
}

func TestOutgoingReferences_TheTitleCounts(t *testing.T) {
	t.Parallel()

	var asked []dashboard.OutgoingTarget
	got := outgoing(t, dashboard.ItemKindIssue, "Follow up #3", "", echoResolver(&asked))

	require.Len(t, got, 1)
	assert.Equal(t, 3, got[0].Number)
}
