package dashboard

import (
	"errors"
	"regexp"
	"regexp/syntax"
	"strings"
)

// TitlePatterns are the issue-title patterns a user leaves out of their
// dashboard (#1630). They use Go's RE2 syntax, which runs in linear time, so no
// pattern can be slow; it has no lookahead, lookbehind or backreferences.
type TitlePatterns struct {
	compiled []*regexp.Regexp
}

// PatternError says why one pattern can't be used, in words a person can act on.
type PatternError struct {
	// Reason is plain words: "missing closing )".
	Reason string
}

func (e *PatternError) Error() string { return e.Reason }

// CompileTitlePatterns compiles patterns so that each matches anywhere in a
// title and ignores case. It stops at the first one that fails, and the error
// is a *PatternError.
func CompileTitlePatterns(patterns []string) (TitlePatterns, error) {
	var out TitlePatterns
	for _, p := range patterns {
		re, err := regexp.Compile("(?i)" + p)
		if err != nil {
			return TitlePatterns{}, &PatternError{Reason: patternReason(err)}
		}
		if re.MatchString("") {
			return TitlePatterns{}, &PatternError{Reason: matchesEverything}
		}
		out.compiled = append(out.compiled, re)
	}

	return out, nil
}

// matchesEverything is the reason for a pattern that matches the empty
// string: it would match every title and hide every issue.
const matchesEverything = "matches every title, so it would hide all issues"

// Matches reports whether any pattern matches title.
func (t TitlePatterns) Matches(title string) bool {
	for _, re := range t.compiled {
		if re.MatchString(title) {
			return true
		}
	}

	return false
}

// patternReason words a compile error. Go's own message names the whole
// wrapped pattern, which the user never typed. It goes by the parser's error
// code and the piece of the pattern it points at, never by searching the text.
func patternReason(err error) string {
	var synErr *syntax.Error
	if !errors.As(err, &synErr) {
		return "not a valid pattern"
	}
	switch {
	case synErr.Code == syntax.ErrInvalidPerlOp && (synErr.Expr == "(?=" || synErr.Expr == "(?!"):
		return "lookahead is not supported"
	case synErr.Code == syntax.ErrInvalidNamedCapture && (strings.HasPrefix(synErr.Expr, "(?<=") || strings.HasPrefix(synErr.Expr, "(?<!")):
		return "lookbehind is not supported"
	case synErr.Code == syntax.ErrInvalidEscape && len(synErr.Expr) == 2 && synErr.Expr[0] == '\\' && synErr.Expr[1] >= '1' && synErr.Expr[1] <= '9':
		return "backreferences are not supported"
	case synErr.Code == syntax.ErrInvalidPerlOp:
		return "invalid or unsupported (?...) group"
	}

	return string(synErr.Code)
}
