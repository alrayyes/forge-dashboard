package api

import "github.com/alrayyes/forge-dashboard/internal/dashboard"

// pageCount is one nav item's numbers (#1315, #1439, #1458): how many items its
// page lists, and how many of those have checks running, failing and passed. An
// item with no checks counts in Total only, so the four need not add up. Matches
// components.schemas.NavCount (Branches) and NavPullRequestCount (the pull
// request pages), which have the same four fields.
type pageCount struct {
	Total   int `json:"total"`
	Running int `json:"running"`
	Failed  int `json:"failed"`
	Passed  int `json:"passed"`
}

// branchCount is the Branches item's numbers: pageCount's four, plus None, how
// many default branches have no pipeline (#1531). A branch whose only trouble
// is a cancelled run counts in Total alone, like a pull request with no
// checks, so the parts need not add up (#1950). Matches
// components.schemas.NavCount.
type branchCount struct {
	pageCount
	None int `json:"none"`
	// AwaitingApproval is how many default branches have workflow runs held
	// until someone approves them (#2024). They are neither running nor failed,
	// so without this they were in the total and in no part of the pill.
	AwaitingApproval int `json:"awaitingApproval"`
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
	Branches     branchCount `json:"branches"`
	PullRequests pageCount   `json:"pullRequests"`
	Issues       issueCount  `json:"issues"`
	Releases     pageCount   `json:"releases"`
	Bots         pageCount   `json:"bots"`
}

// buildNavCounts counts what each page shows when it opens. Pull requests leave
// out ignored repos, drafts and hidden ones, and are split by kind; issues
// leave out the housekeeping ones and what the user's own settings hide
// (#1630). Branches counts the default
// branches it is given, which are the ones GET /api/main-branches lists: a repo
// ignored for pull requests is left out of both (#1337). Show drafts and Show
// hidden change the list a request gets, not the badge, so it doesn't jump
// when a toggle flips. A pull
// request is running when its CI is pending, failed when it is failing and
// passed when it succeeded; one whose only failure is workflow runs held for
// approval is in none of the three. A branch is running, failed or passed with
// its default-branch pipeline. One with no pipeline is counted in None, so a
// branch is always in exactly one of the four (#1531); one whose runs are held
// for approval is counted on its own (#2024). A pull request with no
// checks counts in the total only.
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
	branchCounts := dashboard.CountMainBranches(branches)
	counts.Branches = branchCount{
		Total: branchCounts.Total, Running: branchCounts.Running,
		Failed: branchCounts.Failed, Passed: branchCounts.Passed,
		None: branchCounts.None, AwaitingApproval: branchCounts.AwaitingApproval,
	}

	return counts
}
