package api_test

import (
	"context"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// fakeCheckerSource implements both dashboard.Source and
// dashboard.PullRequestChecker directly — the shape github.Client has,
// since it drives its own Source. Forgejo's real shape is different (see
// TestMCP_GetPullRequestChecks_ForgejoViaGenericSource_ReturnsChecks below) —
// don't assume this fake alone exercises both forges' real wiring.
type fakeCheckerSource struct {
	forge      dashboard.Forge
	checks     []dashboard.Check
	checksErr  error
	lastOwner  string
	lastName   string
	lastNumber int
}

func (f *fakeCheckerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeCheckerSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakeCheckerSource) ListChecks(_ context.Context, owner, name string, number int) ([]dashboard.Check, error) {
	f.lastOwner, f.lastName, f.lastNumber = owner, name, number

	return f.checks, f.checksErr
}

// fakeForgeClientWithChecker implements dashboard.ForgeClient plus
// PullRequestChecker — the real shape internal/forgejo.Client has, driven
// through dashboard.GenericSource rather than being a Source directly.
// #455: a fake Source implementing PullRequestChecker directly (like
// fakeCheckerSource above) never exercises GenericSource's own forwarding
// at all, which is exactly the gap that shipped a real "forgejo doesn't
// support listing pull request checks" regression despite forgejo.Client
// itself already implementing ListChecks correctly.
type fakeForgeClientWithChecker struct {
	checks     []dashboard.Check
	lastOwner  string
	lastName   string
	lastNumber int
}

func (f *fakeForgeClientWithChecker) ListRepos(_ context.Context) ([]dashboard.RepoRef, error) {
	return nil, nil
}

func (f *fakeForgeClientWithChecker) ListOpenPullRequests(_ context.Context, _, _, _ string) ([]dashboard.PullRequest, error) {
	return nil, nil
}

func (f *fakeForgeClientWithChecker) ListOpenIssues(_ context.Context, _, _, _ string) ([]dashboard.Issue, error) {
	return nil, nil
}

func (f *fakeForgeClientWithChecker) ListChecks(_ context.Context, owner, name string, number int) ([]dashboard.Check, error) {
	f.lastOwner, f.lastName, f.lastNumber = owner, name, number

	return f.checks, nil
}
