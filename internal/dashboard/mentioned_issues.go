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
//
// It is a bound on work and memory, not a promise: 100 early references (a
// long changelog) leave a later one unread even when the early ones turn out
// to be closed. The parser can't tell, since what closes depends on the branch
// and on the forge's own list, so a description that long is cut here.
const maxMentionScan = 100

// maxMentionBody is how much of a description is read, in bytes. Scanning
// costs time in step with the text (about a second per megabyte), and a
// description past this is a pasted log or changelog, not the author's own
// mentions. The title is always read.
const maxMentionBody = 64 << 10

// mentionRefPattern finds #N and owner/repo#N the way both forges auto-link
// them: at the start of the text or after whitespace, an opening punctuation
// mark or emphasis and table markup (** _ ~ |). The number has to end there
// too, which refEnds checks ("abc#1", "&#3" and "#4ff" are not references).
var mentionRefPattern = regexp.MustCompile(
	`(?:^|[\s\x0B\p{Z}\x{85}(\[{,;:>"'*_~|])(?:([0-9A-Za-z._-]+/[0-9A-Za-z._-]+))?#([0-9]+)`)

// markdownLinkPattern finds [text](target) on one line, with one level of
// brackets inside the text. The text of a link is not a reference
// ("[#1234](https://redirect.github.com/org/lib/issues/1234)" names an issue
// of org/lib, not of the pull request's repo), and a target counts only as a
// page on the forge, read before this runs.
var markdownLinkPattern = regexp.MustCompile(`\[(?:[^\[\]\n]|\[[^\[\]\n]*\])*\]\([^)\n]*\)`)

// referenceLinkPattern finds [text][label] and [text][], whose target sits in
// a definition further down.
// It is a link only when a definition names the label.
var referenceLinkPattern = regexp.MustCompile(`\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\[([^\[\]\n]*)\]`)

// linkDefinitionPattern finds a "[label]: target" definition as Markdown reads
// one: a single target, in angle brackets or not, on the same line or the
// next, and an optional title. A line with more words after the label
// ("[Context]: relates to #12") is prose and keeps its references.
var linkDefinitionPattern = regexp.MustCompile(
	`(?m)^ {0,3}\[([^\[\]\n]+)\]:[ \t]*(?:\n[ \t]*)?(?:<[^>\n]*>|[^\s<]\S*)` +
		`(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$`)

// shortcutLinkPattern finds a lone [label], a link when a definition names it.
var shortcutLinkPattern = regexp.MustCompile(`\[([^\[\]\n]+)\]`)

// anchorOpenPattern and anchorClosePattern find the tags of an HTML anchor, the
// form Dependabot writes its release notes in. Its href is read as a page link
// first; the text between them counts for nothing, like a Markdown link's.
var (
	anchorOpenPattern  = regexp.MustCompile(`(?i)<a\s[^>]*>`)
	anchorClosePattern = regexp.MustCompile(`(?i)</a\s*>`)
)

// mentionGHPattern finds GitHub's GH-N shorthand for a number in the same repo.
var mentionGHPattern = regexp.MustCompile(`(?i)(?:^|[\s\x0B\p{Z}\x{85}(\[{,;:>"'*_~|])GH-([0-9]+)`)

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
// link, Markdown or HTML, counts for nothing, and so does a link to another
// host. Only the first 64 KiB of the body is read.
// Never nil.
func MentionedIssueRefs(forge Forge, title, body, repo string, number int, baseURL string) []IssueRef {
	refs := []IssueRef{}
	seen := map[string]struct{}{}
	base := strings.TrimRight(baseURL, "/")

	text := uncountedText.ReplaceAllString(title+"\n"+clip(body, maxMentionBody), " ")

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

	// Definitions are found before the page links are blanked, since a
	// target that is a page on the forge would otherwise be only spaces.
	// Every blanking keeps the length of the text, so the places hold.
	definitions := linkDefinitionPattern.FindAllStringSubmatchIndex(text, -1)
	if base != "" {
		page := pagePattern(base)
		for _, m := range page.FindAllStringSubmatchIndex(text, -1) {
			all = append(all, candidate{m[0], text[m[2]:m[3]], text[m[4]:m[5]]})
		}
		text = blank(text, page)
	}
	text = blankAnchors(text)
	text = blank(text, markdownLinkPattern)
	text = blankDefinedLinks(text, definitions)
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

// clip cuts s to at most n bytes, back to the last whitespace (Unicode spaces
// too), so a reference or an address is never read half-written ("#12345"
// must not become "#12"). With no whitespace at all it cuts back to the last
// comma or semicolon instead, so "#1,#2," survives, and to nothing when there
// is none. An anchor still open within maxAnchorText bytes of the cut loses its
// text, which the cut hid the end of.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := cutBack(s, n, unicode.IsSpace)
	if cut < 0 {
		cut = max(cutBack(s, n, isListSeparator), 0)
	}

	return dropOpenAnchor(s[:cut])
}

// maxAnchorText is how far past an opening tag the text of an anchor is
// assumed to run. An open anchor further back than this at the cut is a
// forgotten tag, not one the cut interrupted.
const maxAnchorText = 1 << 10

func isListSeparator(r rune) bool { return r == ',' || r == ';' }

// cutBack finds the last place at or before n where a rune matching cut
// starts, or -1.
func cutBack(s string, n int, cut func(rune) bool) int {
	for i := n; i > 0; i-- {
		if !utf8.RuneStart(s[i]) {
			continue
		}
		if r, _ := utf8.DecodeRuneInString(s[i:]); cut(r) {
			return i
		}
	}

	return -1
}

// dropOpenAnchor removes the text after the last opening <a ...> tag when no
// closing tag follows it and the tag is within maxAnchorText of the end. The
// tag itself stays, so its href still counts.
func dropOpenAnchor(s string) string {
	opens := anchorOpenPattern.FindAllStringIndex(s, -1)
	if len(opens) == 0 {
		return s
	}
	last := opens[len(opens)-1]
	if len(s)-last[1] > maxAnchorText || anchorClosePattern.MatchString(s[last[1]:]) {
		return s
	}

	return s[:last[1]]
}

// blankAnchors blanks each <a ...>text</a>. An opening tag with no closing one
// before the next opening tag is left alone, so it can't swallow what follows.
func blankAnchors(text string) string {
	opens := anchorOpenPattern.FindAllStringIndex(text, -1)
	if len(opens) == 0 {
		return text
	}
	closes := anchorClosePattern.FindAllStringIndex(text, -1)
	out := []byte(text)
	next := 0
	for i, open := range opens {
		for next < len(closes) && closes[next][0] < open[1] {
			next++
		}
		if next == len(closes) {
			break
		}
		if i+1 < len(opens) && opens[i+1][0] < closes[next][0] {
			continue
		}
		for j := open[0]; j < closes[next][1]; j++ {
			if out[j] != '\n' {
				out[j] = ' '
			}
		}
		next++
	}

	return string(out)
}

// label is a link label as Markdown compares it: without case, with runs of
// whitespace as one space.
func label(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(s)), " ")
}

// blankDefinedLinks blanks the links that a "[label]: target" line defines:
// [text][label], [label][] and a lone [label], and the definition lines. A
// bracket pair no definition names is plain text, as it is on the forge.
// definitions holds the submatch indexes of linkDefinitionPattern in text.
func blankDefinedLinks(text string, definitions [][]int) string {
	if len(definitions) == 0 {
		return text
	}
	defined := map[string]struct{}{}
	out := []byte(text)
	for _, m := range definitions {
		defined[label(text[m[2]:m[3]])] = struct{}{}
		for i := m[0]; i < m[1]; i++ {
			if out[i] != '\n' {
				out[i] = ' '
			}
		}
	}
	text = string(out)
	text = referenceLinkPattern.ReplaceAllStringFunc(text, func(s string) string {
		m := referenceLinkPattern.FindStringSubmatch(s)
		name := m[2]
		if name == "" {
			name = m[1]
		}
		if _, ok := defined[label(name)]; ok {
			return strings.Repeat(" ", len(s))
		}

		return s
	})

	return shortcutLinkPattern.ReplaceAllStringFunc(text, func(s string) string {
		if _, ok := defined[label(s[1:len(s)-1])]; ok {
			return strings.Repeat(" ", len(s))
		}

		return s
	})
}
