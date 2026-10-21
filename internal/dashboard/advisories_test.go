package dashboard_test

import (
	"encoding/json"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMainBranch_OmitsAdvisoriesWhenNoSourceReadsThem(t *testing.T) {
	t.Parallel()

	b, err := json.Marshal(dashboard.MainBranch{})

	require.NoError(t, err)
	assert.NotContains(t, string(b), "advisories")
}

func TestUnknownAdvisories_CarriesTheStateNotAnImpliedZero(t *testing.T) {
	t.Parallel()

	b, err := json.Marshal(dashboard.UnknownAdvisories())

	require.NoError(t, err)
	assert.JSONEq(t, `{"state":"unknown","count":0}`, string(b))
}

func TestAdvisorySeverity_RanksCriticalAboveLow(t *testing.T) {
	t.Parallel()

	assert.Greater(t, dashboard.SeverityCritical.Rank(), dashboard.SeverityLow.Rank())
}
