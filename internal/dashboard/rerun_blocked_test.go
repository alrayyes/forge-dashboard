package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A Forgejo with no rerun route says so on the health entry the page locks the
// buttons by, so a person is never offered a click that always fails.
var _ dashboard.RerunChecksBlocker = (*dashboard.GenericSource)(nil)

type fakeNoRerunClient struct {
	fakeRerunnerClient
}

func (*fakeNoRerunClient) RerunChecksBlockedReason() string { return "no rerun here" }

func TestGenericSource_RerunChecksBlockedReason_IsTheClients(t *testing.T) {
	t.Parallel()

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, &fakeNoRerunClient{}, 4)

	assert.Equal(t, "no rerun here", source.RerunChecksBlockedReason())
}

func TestGenericSource_RerunChecksBlockedReason_IsEmptyForAClientThatDoesNotSay(t *testing.T) {
	t.Parallel()

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, &fakeRerunnerClient{}, 4)

	assert.Empty(t, source.RerunChecksBlockedReason())
}

type noRerunSource struct{ fakeSource }

func (*noRerunSource) RerunChecksBlockedReason() string { return "no rerun here" }

func TestAggregator_Refresh_CarriesTheRerunBlockOnTheForgesHealth(t *testing.T) {
	t.Parallel()

	src := &noRerunSource{fakeSource{result: dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true}}}}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	require.Len(t, agg.Get().Forges, 1)
	assert.Equal(t, "no rerun here", agg.Get().Forges[0].RerunChecksBlocked)
}
