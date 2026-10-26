package dashboard_test

import (
	"fmt"

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
