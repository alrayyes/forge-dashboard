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

// fakeAutoMergeSource is a Forgejo source that merges and re-reads pull
// requests, remembering each merge it was asked for.
type fakeAutoMergeSource struct {
	fakeSource

	mergeMu  sync.Mutex
	merged   []string // "owner/name#number"
	mergeErr error
	state    dashboard.PullRequestState
	stateErr error
}

func (f *fakeAutoMergeSource) MergePullRequest(_ context.Context, owner, name string, number int) error {
	f.mergeMu.Lock()
	defer f.mergeMu.Unlock()
	f.merged = append(f.merged, owner+"/"+name+"#"+strconv.Itoa(number))

	return f.mergeErr
}

func (f *fakeAutoMergeSource) ReadPullRequestState(context.Context, string, string, int) (dashboard.PullRequestState, error) {
	return f.state, f.stateErr
}

func (f *fakeAutoMergeSource) mergedPullRequests() []string {
	f.mergeMu.Lock()
	defer f.mergeMu.Unlock()

	return append([]string(nil), f.merged...)
}

// fakeAutoMergeStore is the user's armed set, in memory.
type fakeAutoMergeStore struct {
	mu        sync.Mutex
	armed     map[string]struct{}
	loadErr   error
	cancelled []string
}

func armedStore(keys ...string) *fakeAutoMergeStore {
	s := &fakeAutoMergeStore{armed: map[string]struct{}{}}
	for _, k := range keys {
		s.armed[k] = struct{}{}
	}

	return s
}

func (s *fakeAutoMergeStore) AutoMergeIntents(context.Context, []byte) (map[string]struct{}, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadErr != nil {
		return nil, s.loadErr
	}
	out := map[string]struct{}{}
	for k := range s.armed {
		out[k] = struct{}{}
	}

	return out, nil
}

func (s *fakeAutoMergeStore) CancelAutoMerge(_ context.Context, _ []byte, forge, repo string, number int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := forge + "/" + repo + "#" + strconv.Itoa(number)
	delete(s.armed, key)
	s.cancelled = append(s.cancelled, key)

	return nil
}

func (s *fakeAutoMergeStore) stillArmed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.armed[armedKey]

	return ok
}

const armedKey = "forgejo/alrayyes/a#1"

func amPR(mutate func(*dashboard.PullRequest)) dashboard.PullRequest {
	pr := dashboard.PullRequest{
		Forge: dashboard.ForgeForgejo, Repo: "alrayyes/a", Number: 1,
		CI: dashboard.CISuccess, MergeStatus: dashboard.MergeMergeable,
		UpdatedAt: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC),
	}
	if mutate != nil {
		mutate(&pr)
	}

	return pr
}

func autoMergeAggregator(t *testing.T, store *fakeAutoMergeStore, prs ...dashboard.PullRequest) (*dashboard.Aggregator, *fakeAutoMergeSource) {
	t.Helper()

	src := &fakeAutoMergeSource{}
	src.result = dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		PullRequests: prs,
	}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoMerge([]byte("user-1"), store)

	return agg, src
}

func TestAutoMerge_ArmedPullRequestWithPassingChecks_IsMergedOnce(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, src := autoMergeAggregator(t, store, amPR(nil))

	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1"}, src.mergedPullRequests())
}

func TestAutoMerge_AfterTheMerge_TheIntentIsGone(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, _ := autoMergeAggregator(t, store, amPR(nil))

	agg.Refresh(t.Context())

	assert.False(t, store.stillArmed())
}

func TestAutoMerge_AfterTheMerge_TheBoardNoLongerListsIt(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, _ := autoMergeAggregator(t, store, amPR(nil))

	agg.Refresh(t.Context())

	assert.Empty(t, agg.Get().PullRequests)
}

func TestAutoMerge_NotArmed_NeverMerges(t *testing.T) {
	t.Parallel()
	agg, src := autoMergeAggregator(t, armedStore(), amPR(nil))

	agg.Refresh(t.Context())

	assert.Empty(t, src.mergedPullRequests())
}

func TestAutoMerge_WaitsWhileItShouldNotMerge(t *testing.T) {
	t.Parallel()

	for name, mutate := range map[string]func(*dashboard.PullRequest){
		"checks pending":    func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending },
		"checks failing":    func(p *dashboard.PullRequest) { p.CI = dashboard.CIFailure },
		"no checks yet":     func(p *dashboard.PullRequest) { p.CI = dashboard.CINone },
		"conflicts":         func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting },
		"not yet mergeable": func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnknown },
		"draft":             func(p *dashboard.PullRequest) { p.Draft = true },
		"empty":             func(p *dashboard.PullRequest) { p.Empty = true },
		"github pull request": func(p *dashboard.PullRequest) {
			p.Forge = dashboard.ForgeGitHub
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			store := armedStore(armedKey, "github/alrayyes/a#1")
			agg, src := autoMergeAggregator(t, store, amPR(mutate))

			agg.Refresh(t.Context())

			assert.Empty(t, src.mergedPullRequests())
			assert.True(t, store.stillArmed(), "the intent stays so it can merge once the state clears")
		})
	}
}

func TestAutoMerge_FailedMerge_IsNotRetriedOnTheNextRefresh(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, src := autoMergeAggregator(t, store, amPR(nil))
	src.mergeErr = &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("forgejo: POST /x: User not allowed to merge PR")}

	agg.Refresh(t.Context())
	agg.Refresh(t.Context())
	agg.Refresh(t.Context())

	assert.Len(t, src.mergedPullRequests(), 1)
}

func TestAutoMerge_FailedMerge_KeepsTheIntent(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, src := autoMergeAggregator(t, store, amPR(nil))
	src.mergeErr = &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("refused")}

	agg.Refresh(t.Context())

	assert.True(t, store.stillArmed())
}

func TestAutoMerge_FailedMerge_IsTriedAgainOnceThePullRequestChanges(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, src := autoMergeAggregator(t, store, amPR(nil))
	src.mergeErr = &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("refused")}
	agg.Refresh(t.Context())

	src.result.PullRequests = []dashboard.PullRequest{amPR(func(p *dashboard.PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Hour) })}
	agg.Refresh(t.Context())

	assert.Len(t, src.mergedPullRequests(), 2)
}

func TestAutoMerge_PullRequestGone_AndTheForgeSaysItMerged_RemovesTheIntent(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, src := autoMergeAggregator(t, store)
	src.state = dashboard.PullRequestState{Merged: true}

	agg.Refresh(t.Context())

	assert.False(t, store.stillArmed())
}

func TestAutoMerge_PullRequestGone_AndTheForgeSaysItClosed_RemovesTheIntent(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, src := autoMergeAggregator(t, store)
	src.state = dashboard.PullRequestState{Closed: true}

	agg.Refresh(t.Context())

	assert.False(t, store.stillArmed())
}

func TestAutoMerge_PullRequestGone_ButStillOpenOnTheForge_KeepsTheIntent(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, _ := autoMergeAggregator(t, store)

	agg.Refresh(t.Context())

	assert.True(t, store.stillArmed())
}

func TestAutoMerge_PullRequestGone_AndTheForgeCantSay_KeepsTheIntent(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, src := autoMergeAggregator(t, store)
	src.stateErr = errors.New("unreachable")

	agg.Refresh(t.Context())

	assert.True(t, store.stillArmed())
}

func TestAutoMerge_StoreFailure_MergesNothing(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	store.loadErr = errors.New("db down")
	agg, src := autoMergeAggregator(t, store, amPR(nil))

	agg.Refresh(t.Context())

	assert.Empty(t, src.mergedPullRequests())
}

func TestAutoMerge_NotEnabledOnTheAggregator_IsANoOp(t *testing.T) {
	t.Parallel()
	src := &fakeAutoMergeSource{}
	src.result = dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true}, PullRequests: []dashboard.PullRequest{amPR(nil)}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	agg.Refresh(t.Context())

	require.Empty(t, src.mergedPullRequests())
}

func TestAutoMerge_StackedOnAnotherPullRequest_WaitsForTheParent(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	parent := amPR(func(p *dashboard.PullRequest) { p.Number = 9; p.HeadBranch = "feat-a"; p.BaseBranch = "main" })
	child := amPR(func(p *dashboard.PullRequest) { p.HeadBranch = "feat-b"; p.BaseBranch = "feat-a" })
	agg, src := autoMergeAggregator(t, store, parent, child)

	agg.Refresh(t.Context())

	assert.Empty(t, src.mergedPullRequests())
}
