package dashboard

import (
	"slices"
	"strconv"
	"strings"
)

// ClosingIndex answers the reverse of PullRequest.ClosesIssues: which pull
// requests will close an issue. It is built from the pull requests the
// snapshot already holds, so it costs no forge request.
type ClosingIndex map[string][]PullRequest

// PullRequestsClosing indexes prs by the issues they close.
func PullRequestsClosing(prs []PullRequest) ClosingIndex {
	index := ClosingIndex{}
	for _, pr := range prs {
		// Forgejo reads "Closes #5" and "Closes Owner/Repo#5" as two
		// references to one issue, so a pull request is added once per issue.
		seen := map[string]struct{}{}
		for _, ref := range pr.ClosesIssues {
			key := closingKey(pr.Forge, ref.Repo, ref.Number)
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			index[key] = append(index[key], pr)
		}
	}
	for _, list := range index {
		slices.SortFunc(list, func(a, b PullRequest) int {
			if c := strings.Compare(a.Repo, b.Repo); c != 0 {
				return c
			}

			return a.Number - b.Number
		})
	}

	return index
}

// For lists the pull requests that close issue, by repo and number. Never
// nil. A forge holds a number only once, so the match is on the issue's own
// forge, and a repo's name is compared without regard to case, since Forgejo
// writes a reference lowercased.
func (c ClosingIndex) For(issue Issue) []PullRequest {
	found := c[closingKey(issue.Forge, issue.Repo, issue.Number)]
	if found == nil {
		return []PullRequest{}
	}

	return found
}

func closingKey(forge Forge, repo string, number int) string {
	return string(forge) + "\x00" + strings.ToLower(repo) + "\x00" + strconv.Itoa(number)
}
