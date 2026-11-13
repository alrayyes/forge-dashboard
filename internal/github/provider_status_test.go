package github_test

import (
	"context"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
)

type fixedStatus struct{ answer *dashboard.ProviderStatus }

func (f fixedStatus) ProviderStatus(context.Context) *dashboard.ProviderStatus { return f.answer }

func TestClient_ProviderStatus(t *testing.T) {
	t.Parallel()

	want := &dashboard.ProviderStatus{Indicator: "minor", Incidents: []string{"Degraded performance"}}

	t.Run("asks the status page it was given", func(t *testing.T) {
		t.Parallel()

		c := github.NewClient("pat", "", "http://127.0.0.1:1")
		c.SetStatusChecker(fixedStatus{want})

		assert.Equal(t, want, c.ProviderStatus(t.Context()))
	})
	t.Run("says nothing without one", func(t *testing.T) {
		t.Parallel()

		assert.Nil(t, github.NewClient("pat", "", "http://127.0.0.1:1").ProviderStatus(t.Context()))
	})
}
