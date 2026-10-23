package dashboard

import (
	"context"
	"slices"
)

// fullPassEvery is how often the scheduled refresh ignores what a Source says
// is unchanged and fetches everything: the first refresh after a start, then
// every sixth one. It bounds how long a change the Source cannot see (a missed
// webhook) can stay out of the snapshot.
const fullPassEvery = 6

type incrementalKey struct{}

// WithIncremental marks ctx as a refresh that may skip repos the Source finds
// unchanged. A Fetch without the mark fetches every repo, so a caller that
// does not know about incremental refreshes (a test, a one-off) gets today's
// behaviour.
func WithIncremental(ctx context.Context) context.Context {
	return context.WithValue(ctx, incrementalKey{}, true)
}

// Incremental reports whether ctx allows a Source to skip unchanged repos.
func Incremental(ctx context.Context) bool {
	v, _ := ctx.Value(incrementalKey{}).(bool)

	return v
}

// incrementalAllowed says whether it may skip
// unchanged repos. It may not when it is the first after a start or every
// sixth one, or when a person asked for it ("Refresh now", a sign-in): a
// background run that a person's request coalesced into counts as theirs.
func (a *Aggregator) incrementalAllowed(ctx context.Context) bool {
	if a.passes.Load()%fullPassEvery == 0 {
		return false
	}

	return background(ctx) && a.userRefreshes.Load() == 0
}

// keepUnchangedRepos puts back what the forge had for each repo its Source
// skipped as unchanged: pull requests, issues and the default-branch row, whole.
// The repo row itself is the Source's own, since it carries the live webhook
// state.
func keepUnchangedRepos(res Result, earlier Snapshot, forge Forge) Result {
	if len(res.Unchanged) == 0 {
		return res
	}
	skipped := make(map[string]bool, len(res.Unchanged))
	for _, name := range res.Unchanged {
		skipped[name] = true
	}
	res.PullRequests = append(slices.Clone(res.PullRequests), slices.DeleteFunc(slices.Clone(earlier.PullRequests), func(pr PullRequest) bool {
		return pr.Forge != forge || !skipped[pr.Repo]
	})...)
	res.Issues = append(slices.Clone(res.Issues), slices.DeleteFunc(slices.Clone(earlier.Issues), func(i Issue) bool {
		return i.Forge != forge || !skipped[i.Repo]
	})...)
	res.MainBranches = append(slices.Clone(res.MainBranches), slices.DeleteFunc(slices.Clone(earlier.MainBranches), func(b MainBranch) bool {
		return b.Forge != forge || !skipped[b.FullName]
	})...)

	return res
}

// refreshContext marks ctx incremental when this refresh may skip unchanged
// repos.
func (a *Aggregator) refreshContext(ctx context.Context) context.Context {
	if a.incrementalAllowed(ctx) {
		return WithIncremental(ctx)
	}

	return ctx
}

// notePass counts a refresh that fetched something. A full pass restarts the
// cycle, however it came about (the first, the sixth, or a person's), so the
// safety net is every sixth real fetch, not every sixth tick: a pass that
// every source sat out on a budget hold uses up no slot.
func (a *Aggregator) notePass(ctx context.Context, fetched bool) {
	switch {
	case !fetched:
	case Incremental(ctx):
		a.passes.Add(1)
	default:
		a.passes.Store(1)
	}
}
