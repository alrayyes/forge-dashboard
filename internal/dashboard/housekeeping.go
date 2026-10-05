package dashboard

import "strings"

// dependencyDashboardTitle is the fixed title Renovate gives its one
// permanently open issue per repo.
const dependencyDashboardTitle = "Dependency Dashboard"

// IsHousekeepingIssue reports whether issue is one a bot keeps open and
// rewrites, not work for a person (#980). Exact title match, the one Renovate
// always uses. The rule lives here so every client lists and counts the same
// issues instead of each copying the title.
func IsHousekeepingIssue(issue Issue) bool {
	return strings.TrimSpace(issue.Title) == dependencyDashboardTitle
}
