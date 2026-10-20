package dashboard

import (
	"regexp"
	"strconv"
	"strings"
)

// IssueRef names one issue a pull request will close when it merges.
type IssueRef struct {
	// Repo is "owner/name": the pull request's own repo for a plain #N, the
	// named one for owner/name#N.
	Repo   string `json:"repo"`
	Number int    `json:"number"`
	// URL is the issue's page on its forge.
	URL string `json:"url"`
}

// maxClosingRefs caps how many references one pull request lists. A
// description with more is a changelog, not a ticket link.
const maxClosingRefs = 20

// closingRefPattern finds one closing reference the way Forgejo reads it
// (modules/references): a keyword at the start of the text or after
// whitespace, ( or [; an optional colon; one space; then #N or owner/repo#N.
// The keyword applies to the one reference right after it, so "closes #1, #2"
// closes #1 only. !N names a pull request, which can't be closed this way.
var closingRefPattern = regexp.MustCompile(
	`(?i)(?:^|[\s(\[])(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?):? ` +
		`(?:([0-9A-Za-z._-]+/[0-9A-Za-z._-]+))?#([0-9]+)\b`)

// uncountedText matches what Forgejo's renderer drops before it looks for
// references: fenced code, inline code spans and HTML comments, which a
// pull request template fills with placeholder text.
var uncountedText = regexp.MustCompile("(?s)```.*?```|~~~.*?~~~|`[^`\n]*`|<!--.*?-->")

// ClosingIssueRefs lists the issues body says it closes, in order of first
// appearance and without repeats. repo is the pull request's own repo and
// baseURL the forge's root ("https://git.example.com"), which turns each
// reference into its issue page. Never nil.
//
// GitHub reports this itself, so only the Forgejo client reads descriptions.
// Forgejo's keyword list is configurable and this uses its default one. Like
// Forgejo, it reads the rendered text: code and HTML comments count for
// nothing, and a number has to end where the reference ends ("#4abc" is none).
func ClosingIssueRefs(body, repo, baseURL string) []IssueRef {
	refs := []IssueRef{}
	seen := map[string]struct{}{}
	base := strings.TrimRight(baseURL, "/")

	body = uncountedText.ReplaceAllString(body, " ")
	for _, m := range closingRefPattern.FindAllStringSubmatch(body, -1) {
		number, err := strconv.Atoi(m[2])
		if err != nil || number <= 0 {
			continue
		}
		target := repo
		if m[1] != "" {
			// Forgejo matches repository names without regard to case.
			target = strings.ToLower(m[1])
		}
		key := target + "#" + m[2]
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		refs = append(refs, IssueRef{Repo: target, Number: number, URL: base + "/" + target + "/issues/" + m[2]})
		if len(refs) == maxClosingRefs {
			break
		}
	}

	return refs
}
