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

// referrer is a pull request or issue that names alrayyes/a#7 in its
// description, as a forge's timeline hands it over.
func referrer(number int, relation dashboard.ReferenceRelation, state dashboard.ReferencedState, body string) dashboard.ItemReference {
	ref := reference("alrayyes/a", number, relation)
	ref.Kind, ref.State, ref.Body = dashboard.ItemKindPullRequest, state, body

	return ref
}

func classify(refs ...dashboard.ItemReference) []dashboard.ItemReference {
	return dashboard.ClassifyIncoming(refs, dashboard.ForgeGitHub, "alrayyes/a", 7, "https://github.com")
}

func TestClassifyIncoming_ARefsMarkerMakesAReference(t *testing.T) {
	t.Parallel()

	for _, state := range []dashboard.ReferencedState{dashboard.ReferencedStateOpen, dashboard.ReferencedStateMerged} {
		got := classify(referrer(12, dashboard.RelationMentions, state, "Refs #7"))

		require.Len(t, got, 1)
		assert.Equal(t, dashboard.RelationRefs, got[0].Relation, "a %s pull request that says Refs references the issue", state)
	}
}

func TestClassifyIncoming_AnOpenAndAMergedPullRequestWithTheSameTextAgree(t *testing.T) {
	t.Parallel()

	for _, body := range []string{"Refs #7", "Related to #7", "See alrayyes/a#7", "Mentions #7 in passing", "Closes #7 (aimed at another branch)"} {
		got := classify(
			referrer(12, dashboard.RelationMentions, dashboard.ReferencedStateOpen, body),
			referrer(13, dashboard.RelationMentions, dashboard.ReferencedStateMerged, body),
		)

		require.Len(t, got, 2)
		assert.Equal(t, got[0].Relation, got[1].Relation, "%q: open and merged land in the same group", body)
	}
}

func TestClassifyIncoming_ABareLinkStaysAMention(t *testing.T) {
	t.Parallel()

	got := classify(referrer(12, dashboard.RelationMentions, dashboard.ReferencedStateMerged, "Touches #7 too."))

	require.Len(t, got, 1)
	assert.Equal(t, dashboard.RelationMentions, got[0].Relation)
}

func TestClassifyIncoming_AReferenceWinsOverAMentionInTheSameText(t *testing.T) {
	t.Parallel()

	got := classify(referrer(12, dashboard.RelationMentions, dashboard.ReferencedStateMerged, "Refs #7.\n\nAlso see the discussion on #7."))

	require.Len(t, got, 1)
	assert.Equal(t, dashboard.RelationRefs, got[0].Relation)
}

func TestClassifyIncoming_AClosingPullRequestStaysClosingWhateverItsTextSays(t *testing.T) {
	t.Parallel()

	got := classify(referrer(12, dashboard.RelationCloses, dashboard.ReferencedStateMerged, "Closes #7\n\nRefs #7, and #7 again."))

	require.Len(t, got, 1)
	assert.Equal(t, dashboard.RelationCloses, got[0].Relation)
}

func TestClassifyIncoming_ARefsToAnotherIssueDoesNotCount(t *testing.T) {
	t.Parallel()

	got := classify(referrer(12, dashboard.RelationMentions, dashboard.ReferencedStateMerged, "Refs #8, mentions #7"))

	require.Len(t, got, 1)
	assert.Equal(t, dashboard.RelationMentions, got[0].Relation, "the marker is on #8, not on #7")
}

func TestClassifyIncoming_ReadsTheIssueRepoCaseInsensitively(t *testing.T) {
	t.Parallel()

	got := classify(referrer(12, dashboard.RelationMentions, dashboard.ReferencedStateMerged, "Refs Alrayyes/A#7"))

	require.Len(t, got, 1)
	assert.Equal(t, dashboard.RelationRefs, got[0].Relation)
}

func TestClassifyIncoming_DoesNotKeepTheTextOrChangeTheInput(t *testing.T) {
	t.Parallel()

	in := []dashboard.ItemReference{referrer(12, dashboard.RelationMentions, dashboard.ReferencedStateMerged, "Refs #7")}

	got := classify(in...)

	assert.Empty(t, got[0].Body)
	assert.Equal(t, dashboard.RelationMentions, in[0].Relation)
}

func TestNewestFirstReferences_ReferenceWinsOverMentionAndClosesOverReference(t *testing.T) {
	t.Parallel()

	got := dashboard.NewestFirstReferences([]dashboard.ItemReference{
		reference("a/b", 1, dashboard.RelationRefs),
		reference("a/b", 2, dashboard.RelationCloses),
		reference("a/b", 1, dashboard.RelationMentions),
		reference("a/b", 2, dashboard.RelationRefs),
		reference("a/b", 2, dashboard.RelationMentions),
	})

	require.Len(t, got, 2)
	assert.Equal(t, dashboard.RelationCloses, got[0].Relation, "#2 closes, however often it also references or mentions")
	assert.Equal(t, dashboard.RelationRefs, got[1].Relation, "#1 references, however often it also mentions")
}

// The board holds an open pull request under one relation: closes, then
// refs, then mention (#4430).
func TestBoardIndexes_APullRequestWithAllThreeIsInTheStrongestOnly(t *testing.T) {
	t.Parallel()

	ref := []dashboard.IssueRef{{Repo: "alrayyes/a", Number: 7}}
	for name, tc := range map[string]struct {
		pr                    dashboard.PullRequest
		closes, refs, mention int
	}{
		"closes beats refs and mention": {dashboard.PullRequest{Forge: dashboard.ForgeGitHub, ClosesIssues: ref, RefsIssues: ref, MentionsIssues: ref}, 1, 0, 0},
		"refs beats mention":            {dashboard.PullRequest{Forge: dashboard.ForgeGitHub, RefsIssues: ref, MentionsIssues: ref}, 0, 1, 0},
		"mention alone":                 {dashboard.PullRequest{Forge: dashboard.ForgeGitHub, MentionsIssues: ref}, 0, 0, 1},
	} {
		prs := []dashboard.PullRequest{tc.pr}
		key := dashboard.IssueKey(dashboard.ForgeGitHub, "alrayyes/a", 7)

		assert.Len(t, dashboard.PullRequestsClosing(prs)[key], tc.closes, name)
		assert.Len(t, dashboard.PullRequestsReferencing(prs)[key], tc.refs, name)
		assert.Len(t, dashboard.PullRequestsMentioning(prs)[key], tc.mention, name)
	}
}
