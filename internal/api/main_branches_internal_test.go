package api

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The budget is graded against the time the caller passes, so the edge where a
// limit resets can be tested without waiting for it.
func TestBuildMainBranchesResponse_GradesTheBudgetAtTheTimeItIsGiven(t *testing.T) {
	t.Parallel()

	resets := time.Date(2030, 1, 1, 12, 0, 0, 0, time.UTC)
	forges := []dashboard.ForgeHealth{{
		Forge: dashboard.ForgeGitHub, Reachable: true,
		RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: resets},
	}}

	before := buildMainBranchesResponse(resets, resets.Add(-time.Minute), forges, nil)
	after := buildMainBranchesResponse(resets, resets.Add(time.Minute), forges, nil)

	require.Len(t, before.Forges, 1)
	assert.Equal(t, dashboard.RateLimitExceeded, before.Forges[0].RateLimitREST.Severity)
	assert.NotEqual(t, dashboard.RateLimitExceeded, after.Forges[0].RateLimitREST.Severity)
}
