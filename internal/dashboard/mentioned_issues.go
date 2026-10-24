package dashboard

import (
	"cmp"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

// maxMentionScan bounds how many references one description is read for. The
// lists show maxClosingRefs of them once the closed ones are off
// (PullRequest.MentionedOnly), so the scan leaves room for those.
const maxMentionScan = 100

// mentionRefPattern finds #N and owner/repo#N the way both forges auto-link
// them: at the start of the text or after whitespace, an opening punctuation
// mark or emphasis and table markup (** _ ~ |). The number has to end there
// too, which refEnds checks ("abc#1", "&#3" and "#4ff" are not references).
var mentionRefPattern = regexp.MustCompile(
	`(?:^|[\s(\[{,;:>"'*_~|])(?:([0-9A-Za-z._-]+/[0-9A-Za-z._-]+))?#([0-9]+)`)

// markdownLinkPattern finds [text](target). The text of a link is not a
// reference ("[#1234](https://redirect.github.com/org/lib/issues/1234)" names
// an issue of org/lib, not of the pull request's repo), and a target counts
// only as a page on the forge, read before this runs.
var markdownLinkPattern = regexp.MustCompile(`\[[^\]]*\]\([^)]*\)`)

// mentionGHPattern finds GitHub's GH-N shorthand for a number in the same repo.
var mentionGHPattern = regexp.MustCompile(`(?i)(?:^|[\s(\[{,;:>"'*_~|])GH-([0-9]+)`)

// MentionedIssueRefs lists the issues and pull requests a pull request's
// title and body mention without closing them, in order of first appearance
// and without repeats. A mention is what GitHub and Forgejo both auto-link: #N,
// owner/repo#N, or a link to an issue or pull request page on the forge at
// baseURL ("https://git.example.com"); on GitHub also GH-N. A closing
// reference is a mention here too: whether it closes depends on the branch
// the pull request aims at, so PullRequest.MentionedOnly takes the closed ones
// off. The pull request itself (number in repo) is not one. Code and HTML
// comments count for nothing, as for closing references; a quoted line still
// counts, since both forges link a reference inside a quote. The text of a
// markdown link counts for nothing, and so does a link to another host.
// Never nil.
func MentionedIssueRefs(forge Forge, title, body, repo string, number int, baseURL string) []IssueRef {
	refs := []IssueRef{}
	seen := map[string]struct{}{}
	base := strings.TrimRight(baseURL, "/")

	text := uncountedText.ReplaceAllString(title+"\n"+body, " ")

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
		if len(refs) == maxMentionScan {
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

// pagePatterns caches the pattern for a forge's issue and pull request pages
// by base address, since a refresh reads every pull request against one base.
var pagePatterns sync.Map

func pagePattern(base string) *regexp.Regexp {
	if cached, ok := pagePatterns.Load(base); ok {
		return cached.(*regexp.Regexp)
	}
	pattern := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(base) +
		`/([0-9A-Za-z._-]+/[0-9A-Za-z._-]+)/(?:issues|pulls?)/([0-9]+)\b`)
	pagePatterns.Store(base, pattern)

	return pattern
}

// refEnds reports whether the reference that ends at end in text stands
// alone: a letter or digit right after it makes it part of a longer word.
func refEnds(text string, end int) bool {
	if end >= len(text) {
		return true
	}
	r, _ := utf8.DecodeRuneInString(text[end:])

	return !unicode.IsLetter(r) && !unicode.IsDigit(r)
}

// mentionCandidates finds every reference in text in the order it appears. A
// page link on the forge is read first, link targets included, so its number
// isn't found twice; then link text and other links are blanked.
func mentionCandidates(forge Forge, text, base string) []candidate {
	var all []candidate

	if base != "" {
		page := pagePattern(base)
		for _, m := range page.FindAllStringSubmatchIndex(text, -1) {
			all = append(all, candidate{m[0], text[m[2]:m[3]], text[m[4]:m[5]]})
		}
		text = blank(text, page)
	}
	text = blank(text, markdownLinkPattern)
	for _, m := range mentionRefPattern.FindAllStringSubmatchIndex(text, -1) {
		if !refEnds(text, m[5]) {
			continue
		}
		target := ""
		if m[2] >= 0 {
			target = text[m[2]:m[3]]
		}
		all = append(all, candidate{m[0], target, text[m[4]:m[5]]})
	}
	if forge == ForgeGitHub {
		for _, m := range mentionGHPattern.FindAllStringSubmatchIndex(text, -1) {
			if refEnds(text, m[3]) {
				all = append(all, candidate{m[0], "", text[m[2]:m[3]]})
			}
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
