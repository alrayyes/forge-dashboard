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

// A Forgejo Source is a GenericSource, so cancelling has to be forwarded to the
// client or every Forgejo run would answer "doesn't support cancelling".
var _ dashboard.RunCanceler = (*dashboard.GenericSource)(nil)

type fakeCancelerClient struct {
	fakeForgeClient
	cancelErr error
	canceled  []string
}

func (f *fakeCancelerClient) CancelRun(_ context.Context, owner, name string, runID int64) error {
	f.canceled = append(f.canceled, fmt.Sprintf("%s/%s run %d", owner, name, runID))

	return f.cancelErr
}

func TestGenericSource_CancelRun_DelegatesToClient(t *testing.T) {
	t.Parallel()

	client := &fakeCancelerClient{}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	require.NoError(t, source.CancelRun(t.Context(), "alrayyes", "scaffold-go-cli", 77))
	assert.Equal(t, []string{"alrayyes/scaffold-go-cli run 77"}, client.canceled)
}

// The forge's own sentence and its error kind have to survive, as for a rerun.
func TestGenericSource_CancelRun_ReturnsTheClientsErrorUnchanged(t *testing.T) {
	t.Parallel()

	want := &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("the run already finished")}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, &fakeCancelerClient{cancelErr: want}, 4)

	assert.Same(t, want, source.CancelRun(t.Context(), "a", "b", 1))
}

func TestGenericSource_CancelRun_UnsupportedClient(t *testing.T) {
	t.Parallel()

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, &fakeForgeClient{}, 4)

	err := source.CancelRun(t.Context(), "a", "b", 1)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "can't cancel")
}
