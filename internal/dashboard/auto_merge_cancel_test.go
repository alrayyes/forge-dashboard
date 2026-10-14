package dashboard_test

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeGitHubSource is a GitHub source that can take a pull request's native
// auto-merge back off, remembering each call.
type fakeGitHubSource struct {
	fakeSource

	mu       sync.Mutex
	disabled []string // "owner/name#number"
	err      error
}

func (f *fakeGitHubSource) DisableAutoMerge(_ context.Context, owner, name string, number int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.disabled = append(f.disabled, owner+"/"+name+"#"+strconv.Itoa(number))

	return f.err
}

func (f *fakeGitHubSource) disabledPullRequests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]string(nil), f.disabled...)
}

func armedGitHubPR(mutate func(*dashboard.PullRequest)) dashboard.PullRequest {
	on := true
	pr := dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1,
		CI: dashboard.CIPending, MergeStatus: dashboard.MergeBlocked, AutoMergeEnabled: &on,
		UpdatedAt: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC),
	}
	if mutate != nil {
		mutate(&pr)
	}

	return pr
}

func gitHubAggregator(t *testing.T, store *fakeAutoMergeStore, prs ...dashboard.PullRequest) (*dashboard.Aggregator, *fakeGitHubSource) {
	t.Helper()

	src := &fakeGitHubSource{}
	src.result = dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: prs,
	}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoMerge([]byte("user-1"), store)

	return agg, src
}

// A pull request that goes empty (its branch landed some other way) has nothing
// left to merge, so an armed auto-merge on it is cancelled and the reason kept
// for the row (#1375).
func TestAutoMerge_GitHubPullRequestThatWentEmpty_HasItsAutoMergeCancelled(t *testing.T) {
	t.Parallel()
	agg, src := gitHubAggregator(t, armedStore(), armedGitHubPR(func(p *dashboard.PullRequest) { p.Empty = true }))

	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1"}, src.disabledPullRequests())
	report := agg.AutoMergeReport()
	require.Contains(t, report.Cancelled, "github/alrayyes/a#1")
	assert.Equal(t, dashboard.ActionAlreadyUpToDate, report.Cancelled["github/alrayyes/a#1"].Refusal.Code)
	assert.Equal(t, "Auto-merge was cancelled: there is nothing left to merge.", report.Cancelled["github/alrayyes/a#1"].Refusal.Message)
}

func TestAutoMerge_GitHubCancel_IsNotRepeatedOnTheNextRefresh(t *testing.T) {
	t.Parallel()
	agg, src := gitHubAggregator(t, armedStore(), armedGitHubPR(func(p *dashboard.PullRequest) { p.Empty = true }))

	agg.Refresh(t.Context())
	agg.Refresh(t.Context())
	agg.Refresh(t.Context())

	assert.Len(t, src.disabledPullRequests(), 1)
}

func TestAutoMerge_GitHubCancel_LeavesAPullRequestAloneThatIsNotEmptyOrNotArmed(t *testing.T) {
	t.Parallel()

	for name, mutate := range map[string]func(*dashboard.PullRequest){
		"armed but not empty": func(*dashboard.PullRequest) {},
		"empty but not armed": func(p *dashboard.PullRequest) { p.Empty = true; p.AutoMergeEnabled = nil },
		"empty and explicitly off": func(p *dashboard.PullRequest) {
			off := false
			p.Empty = true
			p.AutoMergeEnabled = &off
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			agg, src := gitHubAggregator(t, armedStore(), armedGitHubPR(mutate))

			agg.Refresh(t.Context())

			assert.Empty(t, src.disabledPullRequests())
			assert.Empty(t, agg.AutoMergeReport().Cancelled)
		})
	}
}

func TestAutoMerge_GitHubCancel_WhenTheCallFails_NothingIsRecordedAndItIsNotHammered(t *testing.T) {
	t.Parallel()
	agg, src := gitHubAggregator(t, armedStore(), armedGitHubPR(func(p *dashboard.PullRequest) { p.Empty = true }))
	src.err = errors.New("github: graphql: Resource not accessible by integration")

	agg.Refresh(t.Context())
	agg.Refresh(t.Context())

	assert.Len(t, src.disabledPullRequests(), 1, "a failed call waits before it is tried again")
	assert.Empty(t, agg.AutoMergeReport().Cancelled, "the auto-merge is still on, so nothing is claimed")
}

func TestAutoMerge_ForgejoPullRequestThatWentEmpty_HasItsIntentDropped(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, src := autoMergeAggregator(t, store, amPR(func(p *dashboard.PullRequest) { p.Empty = true }))

	agg.Refresh(t.Context())

	assert.False(t, store.stillArmed(), "the intent is dropped")
	assert.Empty(t, src.mergedPullRequests(), "and nothing is merged")
	assert.Contains(t, agg.AutoMergeReport().Cancelled, armedKey)
}

func TestAutoMerge_ForgejoEmptyButNotArmed_IsLeftAlone(t *testing.T) {
	t.Parallel()
	store := armedStore()
	agg, src := autoMergeAggregator(t, store, amPR(func(p *dashboard.PullRequest) { p.Empty = true }))

	agg.Refresh(t.Context())

	assert.Empty(t, store.cancelledKeys())
	assert.Empty(t, src.mergedPullRequests())
	assert.Empty(t, agg.AutoMergeReport().Cancelled)
}

func TestAutoMerge_ForgejoCancel_HappensOnce(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, _ := autoMergeAggregator(t, store, amPR(func(p *dashboard.PullRequest) { p.Empty = true }))

	agg.Refresh(t.Context())
	agg.Refresh(t.Context())
	agg.Refresh(t.Context())

	assert.Equal(t, []string{armedKey}, store.cancelledKeys())
}

// A store that can't be read must not stop GitHub's pull requests from being
// handled, and must not cancel a Forgejo one it can't tell is armed.
func TestAutoMerge_WhenTheArmedSetCannotBeRead_ForgejoIsSkippedAndGitHubStillCancelled(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	store.loadErr = errors.New("database is locked")
	ghSrc := &fakeGitHubSource{}
	ghSrc.result = dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{armedGitHubPR(func(p *dashboard.PullRequest) { p.Empty = true })},
	}
	fjSrc := &fakeAutoMergeSource{}
	fjSrc.result = dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		PullRequests: []dashboard.PullRequest{amPR(func(p *dashboard.PullRequest) { p.Empty = true })},
	}
	agg := dashboard.NewAggregator([]dashboard.Source{fjSrc, ghSrc})
	agg.EnableAutoMerge([]byte("user-1"), store)

	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1"}, ghSrc.disabledPullRequests())
	assert.Empty(t, store.cancelledKeys())
}

// What is kept per pull request goes when the pull request leaves the board, so
// the maps don't grow for ever; one that stays listed keeps its entry, which is
// what stops a stale snapshot from cancelling it twice.
func TestAutoMerge_CancelBookkeeping_IsForgottenWhenThePullRequestLeavesTheBoard(t *testing.T) {
	t.Parallel()
	agg, src := gitHubAggregator(t, armedStore(), armedGitHubPR(func(p *dashboard.PullRequest) { p.Empty = true }))

	agg.Refresh(t.Context())
	require.Len(t, src.disabledPullRequests(), 1)

	src.mu.Lock()
	src.result.PullRequests = nil
	src.mu.Unlock()
	agg.Refresh(t.Context())

	// It comes back armed and empty at the same UpdatedAt, as a stale read could
	// make it: the forgotten attempt means a second cancel, which is harmless
	// for a pull request that really is gone and back.
	src.mu.Lock()
	src.result.PullRequests = []dashboard.PullRequest{armedGitHubPR(func(p *dashboard.PullRequest) { p.Empty = true })}
	src.mu.Unlock()
	agg.Refresh(t.Context())

	assert.Len(t, src.disabledPullRequests(), 2)
}
