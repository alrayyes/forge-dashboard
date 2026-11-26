package api

import (
	"encoding/json"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func greenBot() pullRequestView {
	view := pullRequestView{Kind: dashboard.KindDependency}
	view.CI, view.Behind = dashboard.CISuccess, true

	return view
}

// The behind-the-base-branch rule has one implementation (#4990): the Bots menu
// pill's number and each pull request's own fact both read it, so a client
// filters on the server's answer instead of holding a copy.
func TestGreenBehindBase_NamesEachCondition(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		change func(*pullRequestView)
		want   bool
	}{
		"a green bot pull request that is behind": {func(*pullRequestView) {}, true},
		"not behind":                   {func(v *pullRequestView) { v.Behind = false }, false},
		"empty, nothing left to merge": {func(v *pullRequestView) { v.Empty = true }, false},
		"a draft":                      {func(v *pullRequestView) { v.Draft = true }, false},
		"hidden":                       {func(v *pullRequestView) { v.Hidden = true }, false},
		"CI failing":                   {func(v *pullRequestView) { v.CI = dashboard.CIFailure }, false},
		"CI pending":                   {func(v *pullRequestView) { v.CI = dashboard.CIPending }, false},
		"a regular pull request":       {func(v *pullRequestView) { v.Kind = dashboard.KindRegular }, false},
		"a release pull request":       {func(v *pullRequestView) { v.Kind = dashboard.KindRelease }, false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			view := greenBot()
			tc.change(&view)
			assert.Equal(t, tc.want, view.countsAsBehind())
		})
	}
}

// The menu pill counts exactly the pull requests whose own fact is true.
func TestNavCounts_BotsBehindIsTheSumOfTheFact(t *testing.T) {
	t.Parallel()

	for _, view := range navCountsFixtureViews() {
		counts := buildNavCounts([]pullRequestView{view}, 0)
		want := 0
		if view.countsAsBehind() {
			want = 1
		}
		assert.Equal(t, want, counts.Bots.Behind, "%+v", view)
	}
}

// The field a client reads must not disappear from the JSON.
func TestGreenBehindBase_IsOnTheWire(t *testing.T) {
	t.Parallel()

	raw, err := json.Marshal(greenBot())
	require.NoError(t, err)
	var got map[string]any
	require.NoError(t, json.Unmarshal(raw, &got))
	assert.Contains(t, got, "greenBehindBase")
}
