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
	return indexByIssue(prs, func(pr PullRequest) []IssueRef { return pr.ClosesIssues })
}

// PullRequestsMentioning indexes prs by the issues they mention without
// closing: a mention of an issue the same pull request closes is left to the
// closing list, so the two never repeat each other.
func PullRequestsMentioning(prs []PullRequest) ClosingIndex {
	return indexByIssue(prs, PullRequest.MentionedOnly)
}

// MentionedOnly lists the references pr mentions without closing: the
// mentions less what ClosesIssues holds, which is the forge's own word on what
// closes. Cut at maxClosingRefs after the closed ones are off, so a long
// description doesn't push real mentions out. Never nil.
func (pr PullRequest) MentionedOnly() []IssueRef {
	closed := map[string]struct{}{}
	for _, ref := range pr.ClosesIssues {
		closed[closingKey(pr.Forge, ref.Repo, ref.Number)] = struct{}{}
	}
	out := []IssueRef{}
	for _, ref := range pr.MentionsIssues {
		if _, isClosed := closed[closingKey(pr.Forge, ref.Repo, ref.Number)]; isClosed {
			continue
		}
		if out = append(out, ref); len(out) == maxClosingRefs {
			break
		}
	}

	return out
}

// IssuePageURL is the address on this dashboard that opens an issue's pop-up
// on the Issues page.
func IssuePageURL(forge Forge, repo string, number int) string {
	return "/issues.html?issue=" + string(forge) + "/" + repo + "/" + strconv.Itoa(number)
}

func indexByIssue(prs []PullRequest, refsOf func(PullRequest) []IssueRef) ClosingIndex {
	index := ClosingIndex{}
	for _, pr := range prs {
		// Forgejo reads "Closes #5" and "Closes Owner/Repo#5" as two
		// references to one issue, so a pull request is added once per issue.
		seen := map[string]struct{}{}
		for _, ref := range refsOf(pr) {
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
