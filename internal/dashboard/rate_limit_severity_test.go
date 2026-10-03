package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// The severity the page used to work out itself (#806): exceeded is a spent
// budget that has not been seen to reset, low is under 5% left, otherwise ok.
func TestRateLimit_SeverityAt(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	future := now.Add(10 * time.Minute)
	past := now.Add(-time.Minute)

	cases := []struct {
		name string
		rl   dashboard.RateLimit
		want dashboard.RateLimitSeverity
	}{
		{"plenty left", dashboard.RateLimit{Limit: 5000, Remaining: 4000, ResetsAt: future}, dashboard.RateLimitOK},
		{"exactly 5% left is not low yet", dashboard.RateLimit{Limit: 5000, Remaining: 250, ResetsAt: future}, dashboard.RateLimitOK},
		{"just under 5% is low", dashboard.RateLimit{Limit: 5000, Remaining: 249, ResetsAt: future}, dashboard.RateLimitLow},
		{"one request left is low", dashboard.RateLimit{Limit: 5000, Remaining: 1, ResetsAt: future}, dashboard.RateLimitLow},
		{"spent with the reset ahead is exceeded", dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: future}, dashboard.RateLimitExceeded},
		{"spent but already reset is not exceeded", dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: past}, dashboard.RateLimitLow},
		{"spent with no reset time is exceeded, since it can't be said to have reset", dashboard.RateLimit{Limit: 5000, Remaining: 0}, dashboard.RateLimitExceeded},
		{"a zero limit with requests left is ok, not a division by zero", dashboard.RateLimit{Limit: 0, Remaining: 3, ResetsAt: future}, dashboard.RateLimitOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.want, tc.rl.SeverityAt(now))
		})
	}
}
