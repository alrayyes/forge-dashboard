package dashboard_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeReopenerClient struct {
	fakeForgeClient
	reopenErr error
	calls     []string
}

func (f *fakeReopenerClient) ReopenPullRequest(_ context.Context, owner, name string, number int) error {
	f.calls = append(f.calls, owner+"/"+name+fmt.Sprintf("#%d", number))

	return f.reopenErr
}

func TestGenericSource_ReopenPullRequest_DelegatesToClient(t *testing.T) {
	t.Parallel()

	client := &fakeReopenerClient{}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	err := source.ReopenPullRequest(t.Context(), "homelab", "vps-docker", 596)

	require.NoError(t, err)
	require.Len(t, client.calls, 1)
	assert.Equal(t, "homelab/vps-docker#596", client.calls[0])
}

func TestGenericSource_ReopenPullRequest_ClientWithoutSupport_ReturnsError(t *testing.T) {
	t.Parallel()

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, &fakeForgeClient{}, 4)

	err := source.ReopenPullRequest(t.Context(), "homelab", "vps-docker", 596)

	require.Error(t, err)
}

func reopenRefusalErr() error {
	return &dashboard.ClientError{Kind: dashboard.ForgeErrorUnknown, Err: errors.New("github: PATCH /x: Validation Failed")}
}

// Reopening is asked of a closed pull request, so "closed" is the expected
// state on a refusal and says nothing; only a merge explains it.
func TestClassifyActionRefusalFor_Reopen_Merged_SaysAlreadyMerged(t *testing.T) {
	t.Parallel()

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionReopen, reopenRefusalErr(),
		&dashboard.PullRequestState{Merged: true, Closed: true})

	assert.Equal(t, dashboard.ActionAlreadyMerged, got.Code)
}

func TestClassifyActionRefusalFor_Reopen_StillClosed_SaysNotReopenable(t *testing.T) {
	t.Parallel()

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionReopen, reopenRefusalErr(),
		&dashboard.PullRequestState{Closed: true})

	assert.Equal(t, dashboard.ActionNotReopenable, got.Code)
}

func TestClassifyActionRefusalFor_Reopen_StillClosed_NamesTheBranchInPlainWords(t *testing.T) {
	t.Parallel()

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionReopen, reopenRefusalErr(),
		&dashboard.PullRequestState{Closed: true})

	assert.Contains(t, got.Message, "branch")
}

func TestClassifyActionRefusalFor_Reopen_NoReRead_SaysNotReopenable(t *testing.T) {
	t.Parallel()

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionReopen, reopenRefusalErr(), nil)

	assert.Equal(t, dashboard.ActionNotReopenable, got.Code)
}

func TestClassifyActionRefusalFor_Reopen_Unreachable_KeepsUnknown(t *testing.T) {
	t.Parallel()

	err := &dashboard.ClientError{Kind: dashboard.ForgeErrorUnreachable, Err: errors.New("dial tcp: refused")}

	for name, state := range map[string]*dashboard.PullRequestState{
		"no re-read":   nil,
		"still closed": {Closed: true},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionReopen, err, state)

			assert.Equal(t, dashboard.ActionUnknown, got.Code)
		})
	}
}

func TestClassifyActionRefusalFor_Reopen_Unreachable_SaysTheForgeDidntAnswer(t *testing.T) {
	t.Parallel()

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionReopen,
		&dashboard.ClientError{Kind: dashboard.ForgeErrorUnreachable, Err: errors.New("dial tcp: refused")}, nil)

	assert.Contains(t, got.Message, "didn't answer")
}

func TestClassifyActionRefusalFor_Reopen_NotAClientError_KeepsUnknown(t *testing.T) {
	t.Parallel()

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionReopen, errors.New("boom"),
		&dashboard.PullRequestState{Closed: true})

	assert.Equal(t, dashboard.ActionUnknown, got.Code)
}

func TestClassifyActionRefusalFor_Reopen_Conflict_SaysNotReopenable(t *testing.T) {
	t.Parallel()

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionReopen,
		&dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("head branch is gone")},
		&dashboard.PullRequestState{Closed: true})

	assert.Equal(t, dashboard.ActionNotReopenable, got.Code)
}

func TestClassifyActionRefusalFor_Reopen_PermissionStillWins(t *testing.T) {
	t.Parallel()

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionReopen,
		&dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: errors.New("denied")},
		&dashboard.PullRequestState{Closed: true})

	assert.Equal(t, dashboard.ActionPermission, got.Code)
}
