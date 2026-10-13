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

// Rerun failed checks answered 400 "forgejo doesn't support rerunning checks"
// on every Forgejo pull request (#1351): internal/forgejo.Client reruns, but
// GenericSource, which is what a Forgejo Source really is, never forwarded it.
// The same gap #455 and #1347 fixed for other actions.
var _ dashboard.ChecksRerunner = (*dashboard.GenericSource)(nil)

type fakeRerunnerClient struct {
	fakeForgeClient
	rerunErr error
	reran    []string
}

func (f *fakeRerunnerClient) RerunFailedChecks(_ context.Context, owner, name string, number int) error {
	f.reran = append(f.reran, fmt.Sprintf("%s/%s#%d", owner, name, number))

	return f.rerunErr
}

func TestGenericSource_RerunFailedChecks_DelegatesToClient(t *testing.T) {
	t.Parallel()

	client := &fakeRerunnerClient{}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	err := source.RerunFailedChecks(t.Context(), "alrayyes", "scaffold-go-cli", 12)

	require.NoError(t, err)
	assert.Equal(t, []string{"alrayyes/scaffold-go-cli#12"}, client.reran)
}

// The client's error comes back as it is: the API shows the forge's own
// sentence ("no failed job to rerun on this pull request"), and keeps the
// ClientError kind that makes it a 409. A "dashboard:" prefix would swap the
// sentence for the generic one.
func TestGenericSource_RerunFailedChecks_ReturnsTheClientsErrorUnchanged(t *testing.T) {
	t.Parallel()

	want := &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("no failed job to rerun on this pull request")}
	client := &fakeRerunnerClient{rerunErr: want}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	err := source.RerunFailedChecks(t.Context(), "alrayyes", "a", 1)

	assert.Same(t, want, err)
}

func TestGenericSource_RerunFailedChecks_UnsupportedClient(t *testing.T) {
	t.Parallel()

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, &fakeForgeClient{}, 4)

	err := source.RerunFailedChecks(t.Context(), "alrayyes", "a", 1)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "not supported by this client")
}
