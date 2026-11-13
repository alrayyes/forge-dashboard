package dashboard_test

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// statusSource is a forge source that can also say what its provider's status
// page reports, counting how often it was asked (#3633).
type statusSource struct {
	forge  dashboard.Forge
	health dashboard.ForgeHealth
	status *dashboard.ProviderStatus
	asked  atomic.Int32
}

func (s *statusSource) Forge() dashboard.Forge { return s.forge }

func (s *statusSource) Fetch(context.Context) dashboard.Result {
	return dashboard.Result{Health: s.health}
}

func (s *statusSource) ProviderStatus(context.Context) *dashboard.ProviderStatus {
	s.asked.Add(1)

	return s.status
}

var incident = &dashboard.ProviderStatus{
	Indicator:  "minor",
	Components: []string{"Pull Requests"},
	Incidents:  []string{"Degraded performance"},
}

func TestAggregator_ProviderStatus(t *testing.T) {
	t.Parallel()

	failed := func(kind dashboard.ForgeErrorKind) dashboard.ForgeHealth {
		return dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: false, Error: "x", ErrorKind: kind}
	}
	cases := []struct {
		name      string
		health    dashboard.ForgeHealth
		wantAsked int32
		wantShown bool
	}{
		{"a failed GitHub call attaches the incident", failed(dashboard.ForgeErrorUnreachable), 1, true},
		{"a 5xx attaches it too", failed(dashboard.ForgeErrorUpstream), 1, true},
		{"a working forge never asks (criterion 3)", dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, 0, false},
		{"a bad token is not GitHub's incident", failed(dashboard.ForgeErrorUnauthorized), 0, false},
		{"a spent rate limit is not an incident", failed(dashboard.ForgeErrorRateLimited), 0, false},
		{"a restart still checking is not an outage", dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Starting: true, ErrorKind: dashboard.ForgeErrorUnreachable}, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			src := &statusSource{forge: dashboard.ForgeGitHub, health: tc.health, status: incident}
			agg := dashboard.NewAggregator([]dashboard.Source{src})
			agg.Refresh(t.Context())

			got := health(agg.Get(), dashboard.ForgeGitHub)
			assert.Equal(t, tc.wantAsked, src.asked.Load())
			if tc.wantShown {
				require.NotNil(t, got.ProviderStatus)
				assert.Equal(t, incident, got.ProviderStatus)
			} else {
				assert.Nil(t, got.ProviderStatus)
			}
		})
	}

	t.Run("a status feed with nothing to say leaves the health alone (criteria 2, 4)", func(t *testing.T) {
		t.Parallel()

		src := &statusSource{forge: dashboard.ForgeGitHub, health: failed(dashboard.ForgeErrorUnreachable)}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())

		got := health(agg.Get(), dashboard.ForgeGitHub)
		assert.Nil(t, got.ProviderStatus)
		assert.Equal(t, "x", got.Error)
	})

	t.Run("a forge without a status page is not asked", func(t *testing.T) {
		t.Parallel()

		src := &flakySource{forge: dashboard.ForgeForgejo, down: true}
		agg := dashboard.NewAggregator([]dashboard.Source{src})
		agg.Refresh(t.Context())

		assert.Nil(t, health(agg.Get(), dashboard.ForgeForgejo).ProviderStatus)
	})
}
