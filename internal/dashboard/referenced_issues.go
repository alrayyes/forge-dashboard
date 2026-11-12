package dashboard

import "regexp"

// refKeywordBefore matches the end of the text before a reference when a
// reference keyword leads up to it: Refs, Ref, Related to or See, an optional
// colon, then any references already listed after it ("Refs #3, #4 and #5").
// It is anchored to the line, so a keyword on the line above doesn't count.
var refKeywordBefore = regexp.MustCompile(
	`(?i)(?:^|[^\pL\pN_])(?:refs?|related to|see)(?:[ \t]*:)?[ \t]*` +
		`(?:(?:[0-9A-Za-z._-]+/[0-9A-Za-z._-]+)?(?:#|GH-)[0-9]+[ \t]*(?:,|;|&|and)?[ \t]*)*$`)

// ReferencedIssueRefs lists the issues a pull request's title and body
// reference with Refs, Ref, Related to or See ("Refs #12", "See owner/repo#3"),
// the way people mark work on a ticket that stays open. Several may follow one
// keyword ("Refs #3, #4 and #5"). It reads the text like MentionedIssueRefs
// does, so code, comments and link text count for nothing and a reference to
// the pull request itself is left out. A ticket the pull request also closes
// is taken off later (PullRequest.RefsOnly). Never nil.
func ReferencedIssueRefs(forge Forge, title, body, repo string, number int, baseURL string) []IssueRef {
	return scanMentions(forge, title, body, repo, number, baseURL, func(text string, at int) bool {
		// A reference on the line after the keyword isn't its reference.
		if at < len(text) && (text[at] == '\n' || text[at] == '\r') {
			return false
		}
		start := 0
		for i := at - 1; i >= 0; i-- {
			if text[i] == '\n' {
				start = i + 1

				break
			}
		}

		return refKeywordBefore.MatchString(text[start:at])
	})
}
