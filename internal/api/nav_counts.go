package api

import "github.com/alrayyes/forge-dashboard/internal/dashboard"

// pageCount is one nav item's numbers: how many items its page lists, and how
// many of those fail. Matches components.schemas.NavCount.
type pageCount struct {
	Total  int `json:"total"`
	Failed int `json:"failed"`
}

// pullRequestCount is a pull request page's numbers (#1439): how many it lists
// and how many of those have checks running, failing and passed. A pull request
// with no checks counts in Total only, so the four need not add up. Matches
// components.schemas.NavPullRequestCount.
type pullRequestCount struct {
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

// navCounts is what every nav badge shows (#1315), so a client needs one read
// of the snapshot it already has, and the stream keeps the numbers live.
// Matches components.schemas.NavCounts.
type navCounts struct {
	Branches     pageCount        `json:"branches"`
	PullRequests pullRequestCount `json:"pullRequests"`
	Issues       issueCount       `json:"issues"`
	Releases     pullRequestCount `json:"releases"`
	Bots         pullRequestCount `json:"bots"`
}

// buildNavCounts counts what each page shows when it opens. Pull requests leave
// out ignored repos, drafts and hidden ones, and are split by kind; issues
// leave out the housekeeping ones. Branches counts the default
// branches it is given, which are the ones GET /api/main-branches lists: a repo
// ignored for pull requests is left out of both (#1337). Show drafts and Show
// hidden change the list a request gets, not the badge, so it doesn't jump
// when a toggle flips. A pull
// request is running when its CI is pending, failed when it is failing and
// passed when it succeeded; a branch is failed when its default-branch
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
		switch pr.CI {
		case dashboard.CIPending:
			page.Running++
		case dashboard.CIFailure:
			page.Failed++
		case dashboard.CISuccess:
			page.Passed++
		}
	}
	counts.Issues.Total = openIssues
	branchCounts := dashboard.CountMainBranches(branches)
	counts.Branches = pageCount{Total: branchCounts.Total, Failed: branchCounts.Failed}

	return counts
}
