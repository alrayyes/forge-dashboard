package api

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The Out of date rule has one implementation (#4993): the row's badge, the
// quick filter and the Update branch refusal all read it, so a client filters
// on the server's answer instead of holding a copy.
func TestOutOfDate_NamesEachCondition(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		change func(*dashboard.PullRequest)
		want   bool
	}{
		"behind with something left to merge": {func(*dashboard.PullRequest) {}, true},
		"not behind":                          {func(p *dashboard.PullRequest) { p.Behind = false }, false},
		"empty, nothing left to merge":        {func(p *dashboard.PullRequest) { p.Empty = true }, false},
		"a draft is still out of date":        {func(p *dashboard.PullRequest) { p.Draft = true }, true},
		"CI failing is still out of date":     {func(p *dashboard.PullRequest) { p.CI = dashboard.CIFailure }, true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			pr := dashboard.PullRequest{Behind: true}
			tc.change(&pr)
			assert.Equal(t, tc.want, pr.IsOutOfDate())
		})
	}
}

// The behind chip is the Out of date rule narrowed to green bot pull requests.
func TestGreenBehindBase_ImpliesOutOfDate(t *testing.T) {
	t.Parallel()

	for _, view := range navCountsFixtureViews() {
		if view.countsAsBehind() {
			assert.True(t, view.IsOutOfDate(), "%+v", view)
		}
	}
}

// The update-branch refusal says "already up to date" exactly when the rule
// says the pull request is not out of date.
func TestNotOfferedRefusal_UpdateBranchReadsOutOfDate(t *testing.T) {
	t.Parallel()

	for _, pr := range []dashboard.PullRequest{
		{Behind: true},
		{Behind: false},
		{Behind: true, Empty: true},
	} {
		got := notOfferedRefusal(dashboard.ActionUpdateBranch, pr).Code == dashboard.ActionAlreadyUpToDate
		assert.Equal(t, !pr.IsOutOfDate(), got, "%+v", pr)
	}
}

// The field a client reads must not disappear from the JSON.
func TestOutOfDate_IsOnTheWire(t *testing.T) {
	t.Parallel()

	raw, err := json.Marshal(pullRequestView{})
	require.NoError(t, err)
	var got map[string]any
	require.NoError(t, json.Unmarshal(raw, &got))
	assert.Contains(t, got, "outOfDate")
}

// Each pull request the dashboard lists carries the rule's answer.
func TestPullRequestViews_CarryOutOfDate(t *testing.T) {
	t.Parallel()

	prs := []dashboard.PullRequest{
		{Repo: "o/a", Number: 1, Behind: true},
		{Repo: "o/a", Number: 2, Behind: true, Empty: true},
		{Repo: "o/a", Number: 3},
	}
	views, _, _ := boardSettings{now: time.Now()}.pullRequestViews(prs, boardView{})
	require.Len(t, views, 3)
	for _, view := range views {
		assert.Equal(t, view.IsOutOfDate(), view.OutOfDate, "#%d", view.Number)
	}
	assert.True(t, views[0].OutOfDate)
	assert.False(t, views[1].OutOfDate)
}
