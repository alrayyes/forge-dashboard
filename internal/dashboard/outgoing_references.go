package dashboard

import "context"

// MaxOutgoingReferences caps how many items one read looks up for what the
// asked-for item refers to. Each costs a forge lookup, so it is lower than
// MaxReferences.
const MaxOutgoingReferences = 20

// OutgoingTarget is one item the text of an issue or pull request names, and
// what the text does to it.
type OutgoingTarget struct {
	Repo     string
	Number   int
	URL      string
	Relation ReferenceRelation
}

// OutgoingResolver looks the targets up on their forge and returns the ones it
// could show, with kind, state, title and address. A target that is missing or
// that the token can't read is left out of the answer. Direction and relation
// are the caller's to set.
type OutgoingResolver func(ctx context.Context, targets []OutgoingTarget) []ItemReference

// OutgoingReferences lists the items that the title and body of an issue or
// pull request refer to, closing ones first, then references, then plain
// mentions, at most MaxOutgoingReferences and never the item itself. It reads
// the text the way the board reads a pull request's (ClosingIssueRefs,
// ReferencedIssueRefs, MentionedIssueRefs), then asks resolve for what each
// target is now. A closing keyword closes only in a pull request, so in an
// issue it is a mention; this does not check the pull request's base branch.
// Never nil.
func OutgoingReferences(ctx context.Context, forge Forge, kind ItemKind, title, body, repo string, number int, baseURL string, resolve OutgoingResolver) []ItemReference {
	pr := PullRequest{
		Forge:          forge,
		MentionsIssues: MentionedIssueRefs(forge, title, body, repo, number, baseURL),
		RefsIssues:     ReferencedIssueRefs(forge, title, body, repo, number, baseURL),
	}
	if kind == ItemKindPullRequest {
		pr.ClosesIssues = ClosingIssueRefs(body, repo, baseURL)
	}

	var targets []OutgoingTarget
	for _, list := range []struct {
		refs     []IssueRef
		relation ReferenceRelation
	}{
		{pr.ClosesIssues, RelationCloses},
		{pr.RefsOnly(), RelationRefs},
		{pr.MentionedPlainly(), RelationMentions},
	} {
		for _, ref := range list.refs {
			targets = append(targets, OutgoingTarget{Repo: ref.Repo, Number: ref.Number, URL: ref.URL, Relation: list.relation})
		}
	}
	targets = targets[:min(len(targets), MaxOutgoingReferences)]

	refs := []ItemReference{}
	if len(targets) == 0 {
		return refs
	}

	resolved := map[string]ItemReference{}
	for _, ref := range resolve(ctx, targets) {
		resolved[IssueKey(ref.Forge, ref.Repo, ref.Number)] = ref
	}
	for _, target := range targets {
		ref, ok := resolved[IssueKey(forge, target.Repo, target.Number)]
		if !ok {
			continue
		}
		ref.Direction = ReferenceOutgoing
		ref.Relation = target.Relation
		refs = append(refs, ref)
	}

	return refs
}
