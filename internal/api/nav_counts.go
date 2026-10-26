package api

import "github.com/alrayyes/forge-dashboard/internal/dashboard"

// pageCount is one nav item's numbers (#1315, #1439, #1458): how many items its
// page lists, and how many of those have checks running, failing and passed. An
// item with no checks counts in Total only, so the four need not add up. Matches
// components.schemas.NavPullRequestCount.
type pageCount struct {
	Total   int `json:"total"`
	Running int `json:"running"`
	Failed  int `json:"failed"`
	Passed  int `json:"passed"`
}

// issueCount is the Issues item's number. Issues have no failing state, so it
// carries no failed field. Matches components.schemas.NavIssueCount.
type issueCount struct {
	Total int `json:"total"`
}

// navCounts is what the nav badges the server decides show (#1315), so a client
// needs one read of the snapshot it already has, and the stream keeps the
// numbers live. The Branches badge isn't here: the client tallies the main
// branch rows the snapshot carries (#2886). Matches components.schemas.NavCounts.
type navCounts struct {
	PullRequests pageCount  `json:"pullRequests"`
	Issues       issueCount `json:"issues"`
	Releases     pageCount  `json:"releases"`
	Bots         pageCount  `json:"bots"`
}

// buildNavCounts counts what each page shows when it opens. Pull requests leave
// out ignored repos, drafts and hidden ones, and are split by kind; issues
// leave out the housekeeping ones and what the user's own settings hide
// (#1630). Show drafts and Show hidden change the list a request gets, not the
// badge, so it doesn't jump when a toggle flips. A pull request is running when
// its CI is pending, failed when it is failing and passed when it succeeded;
// one whose only failure is workflow runs held for approval is in none of the
// three. A pull request with no checks counts in the total only.
func buildNavCounts(pullRequests []pullRequestView, openIssues int) navCounts {
	var counts navCounts
	for _, pr := range pullRequests {
		if pr.Draft || pr.Hidden {
			continue
		}
		page := &counts.PullRequests
		switch pr.Kind {
		case dashboard.KindRelease:
			page = &counts.Releases
		case dashboard.KindDependency:
			page = &counts.Bots
		}
		page.Total++
		switch pr.CI {
		case dashboard.CIPending:
			page.Running++
		case dashboard.CIFailure:
			// Held runs read as failing but nothing failed: someone has to
			// approve them, so they count in the total only (#1933). A job
			// that really failed beside a held run still counts as failed.
			if dashboard.IsFailingCI(pr.PullRequest) {
				page.Failed++
			}
		case dashboard.CISuccess:
			page.Passed++
		}
	}
	counts.Issues.Total = openIssues

	return counts
}
