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

// Renovate: Rebase on Forgejo answered "forgejo doesn't support labeling pull
// requests" every time (#1347): internal/forgejo.Client labels and edits a pull
// request body, but GenericSource, which is what a Forgejo Source really is,
// exposed neither. The same gap #455 fixed for closing and checks.

// A GenericSource is what the API's capability check asks about, so it has to
// be both of these, not only its client.
var (
	_ dashboard.PullRequestLabeler    = (*dashboard.GenericSource)(nil)
	_ dashboard.PullRequestBodyEditor = (*dashboard.GenericSource)(nil)
)

type fakeLabelerClient struct {
	fakeForgeClient
	labelErr error
	labeled  []string
}

func (f *fakeLabelerClient) AddLabel(_ context.Context, owner, name string, number int, label string) error {
	f.labeled = append(f.labeled, fmt.Sprintf("%s/%s#%d %s", owner, name, number, label))

	return f.labelErr
}

type fakeBodyClient struct {
	fakeLabelerClient
	body    string
	bodyErr error
	setErr  error
	set     []string
}

func (f *fakeBodyClient) PullRequestBody(_ context.Context, _, _ string, _ int) (string, error) {
	return f.body, f.bodyErr
}

func (f *fakeBodyClient) SetPullRequestBody(_ context.Context, owner, name string, number int, body string) error {
	f.set = append(f.set, fmt.Sprintf("%s/%s#%d %s", owner, name, number, body))

	return f.setErr
}

func TestGenericSource_AddLabel_DelegatesToClient(t *testing.T) {
	t.Parallel()

	client := &fakeLabelerClient{}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	err := source.AddLabel(t.Context(), "alrayyes", "scaffold-python-cli", 77, "rebase")

	require.NoError(t, err)
	assert.Equal(t, []string{"alrayyes/scaffold-python-cli#77 rebase"}, client.labeled)
}

func TestGenericSource_AddLabel_PropagatesClientError(t *testing.T) {
	t.Parallel()

	client := &fakeLabelerClient{labelErr: errors.New("forge said no")}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	err := source.AddLabel(t.Context(), "alrayyes", "a", 1, "rebase")

	assert.ErrorContains(t, err, "forge said no")
}

func TestGenericSource_AddLabel_ClientWithoutSupport_ReturnsError(t *testing.T) {
	t.Parallel()

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, &fakeForgeClient{}, 4)

	err := source.AddLabel(t.Context(), "alrayyes", "a", 1, "rebase")

	assert.Error(t, err)
}

func TestGenericSource_PullRequestBody_DelegatesToClient(t *testing.T) {
	t.Parallel()

	client := &fakeBodyClient{body: "the body"}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	body, err := source.PullRequestBody(t.Context(), "alrayyes", "a", 1)

	require.NoError(t, err)
	assert.Equal(t, "the body", body)
}

func TestGenericSource_PullRequestBody_PropagatesClientError(t *testing.T) {
	t.Parallel()

	client := &fakeBodyClient{bodyErr: errors.New("forge said no")}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	_, err := source.PullRequestBody(t.Context(), "alrayyes", "a", 1)

	assert.ErrorContains(t, err, "forge said no")
}

func TestGenericSource_PullRequestBody_ClientWithoutSupport_ReturnsError(t *testing.T) {
	t.Parallel()

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, &fakeLabelerClient{}, 4)

	_, err := source.PullRequestBody(t.Context(), "alrayyes", "a", 1)

	assert.Error(t, err)
}

func TestGenericSource_SetPullRequestBody_DelegatesToClient(t *testing.T) {
	t.Parallel()

	client := &fakeBodyClient{}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	err := source.SetPullRequestBody(t.Context(), "alrayyes", "a", 1, "new body")

	require.NoError(t, err)
	assert.Equal(t, []string{"alrayyes/a#1 new body"}, client.set)
}

func TestGenericSource_SetPullRequestBody_PropagatesClientError(t *testing.T) {
	t.Parallel()

	client := &fakeBodyClient{setErr: errors.New("forge said no")}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	err := source.SetPullRequestBody(t.Context(), "alrayyes", "a", 1, "new body")

	assert.ErrorContains(t, err, "forge said no")
}

func TestGenericSource_SetPullRequestBody_ClientWithoutSupport_ReturnsError(t *testing.T) {
	t.Parallel()

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, &fakeLabelerClient{}, 4)

	err := source.SetPullRequestBody(t.Context(), "alrayyes", "a", 1, "new body")

	assert.Error(t, err)
}

// The whole request through a real GenericSource, as the handler makes it.
func TestRequestRenovateRebase_ThroughAGenericSource_TicksTheBoxWhenThereIsOne(t *testing.T) {
	t.Parallel()

	client := &fakeBodyClient{body: "- [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box"}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	outcome, err := dashboard.RequestRenovateRebase(t.Context(), source, source, "alrayyes", "a", 1, "rebase")

	require.NoError(t, err)
	assert.Equal(t, dashboard.RenovateRebaseTicked, outcome)
	assert.Empty(t, client.labeled)
}

func TestRequestRenovateRebase_ThroughAGenericSource_LabelsWhenThereIsNoBox(t *testing.T) {
	t.Parallel()

	client := &fakeBodyClient{body: "no checkbox here"}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	outcome, err := dashboard.RequestRenovateRebase(t.Context(), source, source, "alrayyes", "a", 1, "rebase")

	require.NoError(t, err)
	assert.Equal(t, dashboard.RenovateRebaseLabeled, outcome)
	assert.Equal(t, []string{"alrayyes/a#1 rebase"}, client.labeled)
}
