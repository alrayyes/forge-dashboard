package dashboard_test

import (
	"errors"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAutoMergeStatusOf(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		mutate    func(*dashboard.PullRequest)
		wantState dashboard.AutoMergeState
		wantCode  dashboard.ActionCode
	}{
		{"checks pending", func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending }, dashboard.AutoMergeWaiting, dashboard.ActionChecksPending},
		{"no checks reported yet", func(p *dashboard.PullRequest) { p.CI = dashboard.CINone }, dashboard.AutoMergeWaiting, dashboard.ActionChecksPending},
		{"checks failing", func(p *dashboard.PullRequest) { p.CI = dashboard.CIFailure }, dashboard.AutoMergeStopped, dashboard.ActionChecksFailing},
		{"conflicts", func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting }, dashboard.AutoMergeStopped, dashboard.ActionConflict},
		{"nothing to merge", func(p *dashboard.PullRequest) { p.Empty = true }, dashboard.AutoMergeStopped, dashboard.ActionAlreadyUpToDate},
		{"draft", func(p *dashboard.PullRequest) { p.Draft = true }, dashboard.AutoMergeWaiting, dashboard.ActionNotMergeable},
		{"forge hasn't said it can merge", func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeUnknown }, dashboard.AutoMergeWaiting, dashboard.ActionNotMergeable},
		{"ready: the next refresh merges it", nil, dashboard.AutoMergeWaiting, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := dashboard.AutoMergeStatusOf(amPR(tc.mutate), nil)

			assert.Equal(t, tc.wantState, got.State)
			assert.Equal(t, tc.wantCode, got.Code)
			assert.NotEmpty(t, got.Message)
		})
	}
}

func TestAutoMergeStatusOf_StackedOnAParent_WaitsForIt(t *testing.T) {
	t.Parallel()
	pr := amPR(func(p *dashboard.PullRequest) { p.StackedOn = &dashboard.StackRef{Number: 9} })

	got := dashboard.AutoMergeStatusOf(pr, nil)

	assert.Equal(t, dashboard.ActionStacked, got.Code)
}

func TestAutoMergeStatusOf_RefusedMerge_StopsWithTheRefusal(t *testing.T) {
	t.Parallel()
	pr := amPR(nil)
	failure := &dashboard.AutoMergeFailure{UpdatedAt: pr.UpdatedAt, Refusal: dashboard.ActionRefusal{Code: dashboard.ActionPermission, Message: "No merge permission."}}

	got := dashboard.AutoMergeStatusOf(pr, failure)

	assert.Equal(t, dashboard.AutoMergeStopped, got.State)
	assert.Contains(t, got.Message, "no merge permission")
}

func TestAutoMergeStatusOf_RateLimitedMerge_Waits(t *testing.T) {
	t.Parallel()
	pr := amPR(nil)
	failure := &dashboard.AutoMergeFailure{UpdatedAt: pr.UpdatedAt, Refusal: dashboard.ActionRefusal{Code: dashboard.ActionRateLimited, Message: "Rate limited."}}

	got := dashboard.AutoMergeStatusOf(pr, failure)

	assert.Equal(t, dashboard.AutoMergeWaiting, got.State)
}

func TestAutoMergeStatusOf_RefusalOfAnOlderVersion_IsIgnored(t *testing.T) {
	t.Parallel()
	pr := amPR(nil)
	failure := &dashboard.AutoMergeFailure{UpdatedAt: pr.UpdatedAt.Add(-time.Hour), Refusal: dashboard.ActionRefusal{Code: dashboard.ActionPermission, Message: "old"}}

	got := dashboard.AutoMergeStatusOf(pr, failure)

	assert.NotEqual(t, dashboard.ActionPermission, got.Code)
}

func TestAutoMerge_RefusedMerge_IsReportedAsAPermissionStop(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, src := autoMergeAggregator(t, store, amPR(nil))
	src.mergeErr = &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("forgejo: POST /repos/a/b/pulls/1/merge: User not allowed to merge PR")}

	agg.Refresh(t.Context())

	failure, ok := agg.AutoMergeReport().Failures[armedKey]
	require.True(t, ok)
	assert.Equal(t, dashboard.ActionPermission, failure.Refusal.Code)
}

func TestAutoMerge_Merged_IsReportedForTheMessage(t *testing.T) {
	t.Parallel()
	store := armedStore(armedKey)
	agg, _ := autoMergeAggregator(t, store, amPR(nil))

	agg.Refresh(t.Context())

	merged := agg.AutoMergeReport().Merged
	require.Len(t, merged, 1)
	assert.Equal(t, "alrayyes/a", merged[0].Repo)
	assert.Equal(t, 1, merged[0].Number)
}

func TestAutoMerge_Merged_IsForgottenAfterTenMinutes(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	src := &fakeAutoMergeSource{}
	src.result = dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true}, PullRequests: []dashboard.PullRequest{amPR(nil)}}
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(func() time.Time { return now }))
	agg.EnableAutoMerge([]byte("user-1"), armedStore(armedKey))
	agg.Refresh(t.Context())

	now = now.Add(11 * time.Minute)

	assert.Empty(t, agg.AutoMergeReport().Merged)
}
