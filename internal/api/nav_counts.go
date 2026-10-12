package api

import "github.com/alrayyes/forge-dashboard/internal/dashboard"

// pageCount is one nav item's numbers: how many items its page lists, and how
// many of those fail. Matches components.schemas.NavCount.
type pageCount struct {
	Total  int `json:"total"`
	Failed int `json:"failed"`
}

// issueCount is the Issues item's number. Issues have no failing state, so it
// carries no failed field. Matches components.schemas.NavIssueCount.
type issueCount struct {
	Total int `json:"total"`
}

// navCounts is what every nav badge shows (#1315), so a client needs one read
// of the snapshot it already has, and the stream keeps the numbers live.
// Matches components.schemas.NavCounts.
type navCounts struct {
	Branches     pageCount  `json:"branches"`
	PullRequests pageCount  `json:"pullRequests"`
	Issues       issueCount `json:"issues"`
	Releases     pageCount  `json:"releases"`
	Bots         pageCount  `json:"bots"`
}

// buildNavCounts counts what each page shows when it opens. Pull requests leave
// out ignored repos, drafts and hidden ones, and are split by kind; issues
// leave out the housekeeping ones. Branches counts every tracked default
// branch, ignored repos included, exactly as GET /api/main-branches lists them
// (whether an ignored repo's branch should count is #1337). Show drafts and Show hidden change the list a request
// gets, not the badge, so it doesn't jump when a toggle flips. A pull
// request is failed when its CI is failing; a branch when its default-branch
// pipeline is. One with no pipeline counts in the total only.
func buildNavCounts(pullRequests []pullRequestView, openIssues int, branches []dashboard.MainBranch) navCounts {
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
		if pr.CI == dashboard.CIFailure {
			page.Failed++
		}
	}
	counts.Issues.Total = openIssues
	branchCounts := dashboard.CountMainBranches(branches)
	counts.Branches = pageCount{Total: branchCounts.Total, Failed: branchCounts.Failed}

	return counts
}
