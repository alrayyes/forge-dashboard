package dashboard

import (
	"cmp"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// mentionRefPattern finds #N and owner/repo#N the way both forges auto-link
// them: at the start of the text or after whitespace or an opening
// punctuation mark, and with the number ending there ("abc#1", "&#3" and
// "#4ff" are not references).
var mentionRefPattern = regexp.MustCompile(
	`(?:^|[\s(\[{,;:>"'])(?:([0-9A-Za-z._-]+/[0-9A-Za-z._-]+))?#([0-9]+)\b`)

// mentionGHPattern finds GitHub's GH-N shorthand for a number in the same repo.
var mentionGHPattern = regexp.MustCompile(`(?i)(?:^|[\s(\[{,;:>"'])GH-([0-9]+)\b`)

// MentionedIssueRefs lists the issues and pull requests a pull request's
// title and body mention without closing them, in order of first appearance
// and without repeats. A mention is what GitHub and Forgejo both auto-link: #N,
// owner/repo#N, or a link to an issue or pull request page on the forge at
// baseURL ("https://git.example.com"); on GitHub also GH-N. A closing
// reference (see ClosingIssueRefs) is not a mention, and neither is the
// pull request itself (number in repo). Code and HTML comments count for
// nothing, as for closing references; a quoted line still counts, since both
// forges link a reference inside a quote. Never nil.
func MentionedIssueRefs(forge Forge, title, body, repo string, number int, baseURL string) []IssueRef {
	refs := []IssueRef{}
	seen := map[string]struct{}{}
	base := strings.TrimRight(baseURL, "/")

	text := uncountedText.ReplaceAllString(title+"\n"+body, " ")
	text = blank(text, closingRefPattern)

	for _, f := range mentionCandidates(forge, text, base) {
		n, err := strconv.Atoi(f.number)
		if err != nil || n <= 0 {
			continue
		}
		target := repo
		if f.repo != "" && !strings.EqualFold(f.repo, repo) {
			// Both forges match repository names without regard to case.
			target = strings.ToLower(f.repo)
		}
		if n == number && strings.EqualFold(target, repo) {
			continue
		}
		key := strings.ToLower(target) + "#" + f.number
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		refs = append(refs, IssueRef{Repo: target, Number: n, URL: base + "/" + target + "/issues/" + f.number})
		if len(refs) == maxClosingRefs {
			break
		}
	}

	return refs
}

// candidate is a reference found in text, before it is checked against the
// pull request it came from.
type candidate struct {
	at     int
	repo   string
	number string
}

// mentionCandidates finds every reference in text, closing keywords already
// blanked, in the order it appears. A page link is read before the shorthand
// forms so its number isn't found twice.
func mentionCandidates(forge Forge, text, base string) []candidate {
	var all []candidate

	if base != "" {
		page := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(base) +
			`/([0-9A-Za-z._-]+/[0-9A-Za-z._-]+)/(?:issues|pulls?)/([0-9]+)\b`)
		for _, m := range page.FindAllStringSubmatchIndex(text, -1) {
			all = append(all, candidate{m[0], text[m[2]:m[3]], text[m[4]:m[5]]})
		}
		text = blank(text, page)
	}
	for _, m := range mentionRefPattern.FindAllStringSubmatchIndex(text, -1) {
		target := ""
		if m[2] >= 0 {
			target = text[m[2]:m[3]]
		}
		all = append(all, candidate{m[0], target, text[m[4]:m[5]]})
	}
	if forge == ForgeGitHub {
		for _, m := range mentionGHPattern.FindAllStringSubmatchIndex(text, -1) {
			all = append(all, candidate{m[0], "", text[m[2]:m[3]]})
		}
	}
	slices.SortStableFunc(all, func(a, b candidate) int { return cmp.Compare(a.at, b.at) })

	return all
}

// blank replaces every match of pattern in text with spaces of the same
// length, so what is left keeps its places.
func blank(text string, pattern *regexp.Regexp) string {
	return pattern.ReplaceAllStringFunc(text, func(s string) string { return strings.Repeat(" ", len(s)) })
}
