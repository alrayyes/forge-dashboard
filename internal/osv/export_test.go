package osv

import (
	"context"
	"time"
)

// DetailConcurrency is how many advisory records a Client fetches at once.
const DetailConcurrency = detailConcurrency

// Clock is the time a budget runs by.
type Clock = clock

// WithBudgetClock is WithBudget on a clock the test drives.
func WithBudgetClock(parent context.Context, d time.Duration, clk Clock) (context.Context, context.CancelFunc) {
	return withBudget(parent, d, clk)
}
