package dashboard_test

import (
	"fmt"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// A bot's housekeeping issue is flagged by the server, so every client lists
// and counts the same issues as work.
func ExampleIsHousekeepingIssue() {
	fmt.Println(dashboard.IsHousekeepingIssue(dashboard.Issue{Title: "Dependency Dashboard"}))
	fmt.Println(dashboard.IsHousekeepingIssue(dashboard.Issue{Title: "Fix the login page"}))
	// Output:
	// true
	// false
}

// A rate-limit budget is graded in one place: ok, then warning under 20% left,
// low under 5%, and exceeded once nothing is left and the reset is ahead.
func ExampleRateLimit_SeverityAt() {
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	reset := now.Add(10 * time.Minute)

	for _, remaining := range []int{4000, 800, 100, 0} {
		rl := dashboard.RateLimit{Limit: 5000, Remaining: remaining, ResetsAt: reset}
		fmt.Println(remaining, rl.SeverityAt(now))
	}
	// Output:
	// 4000 ok
	// 800 warning
	// 100 low
	// 0 exceeded
}
