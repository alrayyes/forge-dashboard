package api_test

import (
	"context"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// fakeBranchCheckerSource implements dashboard.Source and
// dashboard.DefaultBranchChecker directly, the shape github.Client has.
type fakeBranchCheckerSource struct {
	forge     dashboard.Forge
	checks    []dashboard.Check
	checksErr error
	lastOwner string
	lastName  string
	// tracked is the repos Fetch reports a default branch row for.
	tracked []string
}

func (f *fakeBranchCheckerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeBranchCheckerSource) Fetch(_ context.Context) dashboard.Result {
	rows := make([]dashboard.MainBranch, 0, len(f.tracked))
	for _, full := range f.tracked {
		rows = append(rows, dashboard.MainBranch{Forge: f.forge, FullName: full, Branch: "main", Status: dashboard.MainBranchFailed})
	}

	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}, MainBranches: rows}
}

func (f *fakeBranchCheckerSource) ListDefaultBranchChecks(_ context.Context, owner, name string) ([]dashboard.Check, error) {
	f.lastOwner, f.lastName = owner, name

	return f.checks, f.checksErr
}

// fakeForgeClientWithBranchChecker is the real shape internal/forgejo.Client
// has, driven through dashboard.GenericSource, so the Source's own forwarding
// is exercised too.
type fakeForgeClientWithBranchChecker struct {
	fakeForgeClientWithChecker
}

func (f *fakeForgeClientWithBranchChecker) ListDefaultBranchChecks(_ context.Context, owner, name string) ([]dashboard.Check, error) {
	f.lastOwner, f.lastName = owner, name

	return f.checks, nil
}
