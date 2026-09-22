package dashboard_test

import (
	"context"
	"strconv"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeBranchUpdaterSource is fakeSource plus dashboard.BranchUpdater —
// fakeSource itself deliberately doesn't implement it (refresh_repo_test.go
// relies on that to test the "source doesn't support it" fallback), so
// auto-update-branch's own tests get their own fake instead of widening
// the shared one out from under that other test.
type fakeBranchUpdaterSource struct {
	fakeSource

	mu      sync.Mutex
	updated []string // "owner/name#number"
}

func (f *fakeBranchUpdaterSource) UpdateBranch(_ context.Context, owner, name string, number int) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updated = append(f.updated, owner+"/"+name+"#"+strconv.Itoa(number))

	return false, nil
}

func (f *fakeBranchUpdaterSource) updatedBranches() []string {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]string(nil), f.updated...)
}

// fakeAutoUpdateBranchLister implements dashboard.AutoUpdateBranchLister
// against a fixed, in-memory set — no real settings.Store needed to test
// the Aggregator's own use of it.
type fakeAutoUpdateBranchLister struct {
	enabled           map[string]struct{}
	allowBotPRUpdates bool
	renovateLabel     string
	err               error
	botErr            error
	labelErr          error
}

func (f *fakeAutoUpdateBranchLister) AutoUpdateBranchRepos(_ context.Context, _ []byte) (map[string]struct{}, error) {
	if f.err != nil {
		return nil, f.err
	}

	return f.enabled, nil
}

func (f *fakeAutoUpdateBranchLister) AllowsBotPRUpdates(_ context.Context, _ []byte) (bool, error) {
	if f.botErr != nil {
		return false, f.botErr
	}

	return f.allowBotPRUpdates, nil
}

func (f *fakeAutoUpdateBranchLister) RenovateRebaseLabel(_ context.Context, _ []byte) (string, error) {
	if f.labelErr != nil {
		return "", f.labelErr
	}
	if f.renovateLabel == "" {
		return "rebase", nil
	}

	return f.renovateLabel, nil
}

func TestAggregator_Refresh_BehindPROnEnabledRepo_UpdatesBranch(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled: map[string]struct{}{"github/alrayyes/a": {}},
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1"}, src.updatedBranches())
}

func TestAggregator_Refresh_PRNotBehind_LeavesItAlone(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: false},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled: map[string]struct{}{"github/alrayyes/a": {}},
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches())
}

func TestAggregator_Refresh_BehindPROnRepoNotEnabled_LeavesItAlone(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{enabled: map[string]struct{}{}}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches())
}

func TestAggregator_Refresh_BehindBotManagedPR_SkippedUnlessAllowed(t *testing.T) {
	t.Parallel()

	// release-please, not Renovate or Dependabot: those two get their own
	// routing (label / comment) once bot-PR updates are allowed, tested
	// separately below — this covers the shared gate ahead of that routing.
	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Labels: []dashboard.Label{{Name: "autorelease: pending"}}},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: false,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches(), "bot-managed and allowBotPRUpdates is false")
}

func TestAggregator_Refresh_BehindBotManagedPR_UpdatedWhenAllowed(t *testing.T) {
	t.Parallel()

	// release-please, not Renovate or Dependabot — see the sibling
	// "SkippedUnlessAllowed" test's own comment.
	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Labels: []dashboard.Label{{Name: "autorelease: pending"}}},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: true,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1"}, src.updatedBranches())
}

func TestAggregator_Refresh_NoAutoUpdateEnabled_NeverCallsLister(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true},
		},
	}}}

	// EnableAutoUpdateBranch never called — same as every Aggregator
	// before #365, and Manager's own construction when no
	// AutoUpdateBranchLister is configured.
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches())
}

// fakeCommenterAndUpdaterSource is fakeBranchUpdaterSource plus
// dashboard.PullRequestCommenter — the shape github.Client has, and what the
// Dependabot auto-rebase/recreate tests need since they exercise both
// UpdateBranch (a mixed-in non-Dependabot PR) and CommentPullRequest
// (the Dependabot PR itself) against the same source.
type fakeCommenterAndUpdaterSource struct {
	fakeBranchUpdaterSource

	commentMu  sync.Mutex
	commented  []string // "owner/name#number: body"
	commentErr error
}

func (f *fakeCommenterAndUpdaterSource) CommentPullRequest(_ context.Context, owner, name string, number int, body string) error {
	f.commentMu.Lock()
	defer f.commentMu.Unlock()
	f.commented = append(f.commented, owner+"/"+name+"#"+strconv.Itoa(number)+": "+body)

	return f.commentErr
}

func (f *fakeCommenterAndUpdaterSource) comments() []string {
	f.commentMu.Lock()
	defer f.commentMu.Unlock()

	return append([]string(nil), f.commented...)
}

// fakeLabelerAndUpdaterSource is fakeBranchUpdaterSource plus
// dashboard.PullRequestLabeler — the shape both forges' clients have, and
// what the Renovate auto-rebase-label tests need since they exercise both
// UpdateBranch (a mixed-in non-Renovate PR) and AddLabel (the Renovate PR
// itself) against the same source.
type fakeLabelerAndUpdaterSource struct {
	fakeBranchUpdaterSource

	labelMu  sync.Mutex
	labeled  []string // "owner/name#number: label"
	labelErr error
}

func (f *fakeLabelerAndUpdaterSource) AddLabel(_ context.Context, owner, name string, number int, label string) error {
	f.labelMu.Lock()
	defer f.labelMu.Unlock()
	f.labeled = append(f.labeled, owner+"/"+name+"#"+strconv.Itoa(number)+": "+label)

	return f.labelErr
}

func (f *fakeLabelerAndUpdaterSource) labels() []string {
	f.labelMu.Lock()
	defer f.labelMu.Unlock()

	return append([]string(nil), f.labeled...)
}

func TestAggregator_Refresh_BehindDependabotPR_PostsRebaseComment(t *testing.T) {
	t.Parallel()

	src := &fakeCommenterAndUpdaterSource{fakeBranchUpdaterSource: fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeCommenterAndUpdaterSource also carries commentMu/commented; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "dependabot"},
		},
	}}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: true,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1: " + dashboard.DependabotRebaseComment}, src.comments())
}

func TestAggregator_Refresh_BehindDependabotPR_NeverCallsUpdateBranch(t *testing.T) {
	t.Parallel()

	src := &fakeCommenterAndUpdaterSource{fakeBranchUpdaterSource: fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeCommenterAndUpdaterSource also carries commentMu/commented; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "dependabot"},
		},
	}}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: true,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches(), "a Dependabot PR must go through its own rebase comment, not the generic UpdateBranch")
}

func TestAggregator_Refresh_DependabotRebaseThenCIFails_PostsRecreateOnce(t *testing.T) {
	t.Parallel()

	src := &fakeCommenterAndUpdaterSource{fakeBranchUpdaterSource: fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeCommenterAndUpdaterSource also carries commentMu/commented; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "dependabot", CI: dashboard.CIPending},
		},
	}}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: true,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	// Dependabot pushed its own rebase commit: no longer behind, but that
	// commit's own CI has now failed.
	src.result.PullRequests = []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: false, Author: "dependabot", CI: dashboard.CIFailure},
	}
	agg.Refresh(t.Context())

	// A third refresh, still failing, must not post a second recreate.
	agg.Refresh(t.Context())

	assert.Equal(t, []string{
		"alrayyes/a#1: " + dashboard.DependabotRebaseComment,
		"alrayyes/a#1: " + dashboard.DependabotRecreateComment,
	}, src.comments())
}

func TestAggregator_Refresh_DependabotRebaseThenCISucceeds_NeverRecreates(t *testing.T) {
	t.Parallel()

	src := &fakeCommenterAndUpdaterSource{fakeBranchUpdaterSource: fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeCommenterAndUpdaterSource also carries commentMu/commented; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "dependabot", CI: dashboard.CIPending},
		},
	}}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: true,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	src.result.PullRequests = []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: false, Author: "dependabot", CI: dashboard.CISuccess},
	}
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1: " + dashboard.DependabotRebaseComment}, src.comments())
}

func TestAggregator_Refresh_DependabotRebaseStillPending_DoesNotRecreateYet(t *testing.T) {
	t.Parallel()

	src := &fakeCommenterAndUpdaterSource{fakeBranchUpdaterSource: fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeCommenterAndUpdaterSource also carries commentMu/commented; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "dependabot", CI: dashboard.CIPending},
		},
	}}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: true,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	// Dependabot's own rebase commit landed (no longer behind), but that
	// commit's checks haven't finished yet — must not treat "not yet
	// resolved" as "failed".
	src.result.PullRequests = []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: false, Author: "dependabot", CI: dashboard.CIPending},
	}
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1: " + dashboard.DependabotRebaseComment}, src.comments())
}

func TestAggregator_Refresh_DependabotPRClosedAfterRebase_StopsWatchingWithoutRecreate(t *testing.T) {
	t.Parallel()

	src := &fakeCommenterAndUpdaterSource{fakeBranchUpdaterSource: fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeCommenterAndUpdaterSource also carries commentMu/commented; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "dependabot", CI: dashboard.CIPending},
		},
	}}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: true,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	// Merged or closed before its rebase's CI ever resolved.
	src.result.PullRequests = nil
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1: " + dashboard.DependabotRebaseComment}, src.comments())
}

func TestAggregator_Refresh_ListerErrors_RefreshStillSucceeds(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
	}}
	lister := &fakeAutoUpdateBranchLister{err: assert.AnError}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)

	require.NotPanics(t, func() { agg.Refresh(t.Context()) })
	assert.True(t, agg.Get().Forges[0].Reachable, "a lister failure must not corrupt the snapshot it has nothing to do with")
}

func TestAggregator_Refresh_AllowsBotPRUpdatesErrors_RefreshStillSucceeds(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled: map[string]struct{}{"github/alrayyes/a": {}},
		botErr:  assert.AnError,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)

	require.NotPanics(t, func() { agg.Refresh(t.Context()) })
	assert.Empty(t, src.updatedBranches(), "a failure to learn the bot-pr-updates setting must not update anything it can't yet classify correctly")
	assert.True(t, agg.Get().Forges[0].Reachable)
}

func TestAggregator_Refresh_BehindRenovatePR_AddsRebaseLabelInsteadOfUpdatingBranch(t *testing.T) {
	t.Parallel()

	src := &fakeLabelerAndUpdaterSource{fakeBranchUpdaterSource: fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeLabelerAndUpdaterSource also carries labelMu/labeled; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "renovate"},
		},
	}}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: true,
		renovateLabel:     "needs-rebase",
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1: needs-rebase"}, src.labels())
	assert.Empty(t, src.updatedBranches(), "a Renovate PR must go through AddLabel, never the generic UpdateBranch")
}

func TestAggregator_Refresh_BehindRenovatePROnForgejo_AddsRebaseLabelInsteadOfUpdatingBranch(t *testing.T) {
	t.Parallel()

	src := &fakeLabelerAndUpdaterSource{fakeBranchUpdaterSource: fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeLabelerAndUpdaterSource also carries labelMu/labeled; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeForgejo, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "renovate[bot]"},
		},
	}}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"forgejo/alrayyes/a": {}},
		allowBotPRUpdates: true,
		renovateLabel:     "rebase",
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1: rebase"}, src.labels())
	assert.Empty(t, src.updatedBranches())
}

func TestAggregator_Refresh_BehindRenovatePR_LabelFailureIsLoggedNotFatal(t *testing.T) {
	t.Parallel()

	src := &fakeLabelerAndUpdaterSource{
		result: dashboard.Result{
			Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
			PullRequests: []dashboard.PullRequest{
				{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "renovate"},
			},
		},
		labelErr: assert.AnError,
	}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: true,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)

	require.NotPanics(t, func() { agg.Refresh(t.Context()) })
	assert.True(t, agg.Get().Forges[0].Reachable, "an AddLabel failure must not corrupt the snapshot it has nothing to do with")
}

func TestAggregator_Refresh_BehindNonRenovatePR_UnchangedBehavior(t *testing.T) {
	t.Parallel()

	src := &fakeLabelerAndUpdaterSource{fakeBranchUpdaterSource: fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeLabelerAndUpdaterSource also carries labelMu/labeled; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true},
		},
	}}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: true,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1"}, src.updatedBranches())
	assert.Empty(t, src.labels())
}
