package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// What a pull request says about automatic branch updates: the effective
// choice, where it comes from, and why a switch would do nothing.

func TestPullRequestAutoUpdate_FollowsTheRepoWithoutAChoice(t *testing.T) {
	t.Parallel()
	pr := dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1}

	on := dashboard.PullRequestAutoUpdate(pr, true, nil)
	off := dashboard.PullRequestAutoUpdate(pr, false, nil)

	assert.Equal(t, dashboard.AutoUpdate{Enabled: true, Source: dashboard.AutoUpdateFromRepo}, on)
	assert.Equal(t, dashboard.AutoUpdate{Enabled: false, Source: dashboard.AutoUpdateFromRepo}, off)
}

func TestPullRequestAutoUpdate_ItsOwnChoiceWinsBothWays(t *testing.T) {
	t.Parallel()
	pr := dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1}

	optedOut := dashboard.PullRequestAutoUpdate(pr, true, new(false))
	optedIn := dashboard.PullRequestAutoUpdate(pr, false, new(true))

	assert.Equal(t, dashboard.AutoUpdate{Enabled: false, Source: dashboard.AutoUpdateFromPullRequest}, optedOut)
	assert.Equal(t, dashboard.AutoUpdate{Enabled: true, Source: dashboard.AutoUpdateFromPullRequest}, optedIn)
}

func TestPullRequestAutoUpdate_ADraftIsNeverUpdated_AndSaysWhy(t *testing.T) {
	t.Parallel()
	pr := dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Draft: true}

	got := dashboard.PullRequestAutoUpdate(pr, true, new(true))

	assert.False(t, got.Enabled)
	require.NotNil(t, got.Unavailable)
	assert.Equal(t, dashboard.AutoUpdateDraft, got.Unavailable.Code)
	assert.NotEmpty(t, got.Unavailable.Reason)
}

func TestPullRequestAutoUpdate_AReleasePleasePullRequestIsNeverUpdated_AndSaysWhy(t *testing.T) {
	t.Parallel()
	pr := dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Labels: []dashboard.Label{{Name: "autorelease: pending"}}}

	got := dashboard.PullRequestAutoUpdate(pr, true, nil)

	assert.False(t, got.Enabled)
	require.NotNil(t, got.Unavailable)
	assert.Equal(t, dashboard.AutoUpdateReleasePlease, got.Unavailable.Code)
}

func TestPullRequestAutoUpdate_AnOrdinaryPullRequestHasNoUnavailableReason(t *testing.T) {
	t.Parallel()
	pr := dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1}

	got := dashboard.PullRequestAutoUpdate(pr, true, nil)

	assert.Nil(t, got.Unavailable)
}
