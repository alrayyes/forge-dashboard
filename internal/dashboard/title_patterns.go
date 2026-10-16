package dashboard

import (
	"fmt"
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
		out.compiled = append(out.compiled, re)
	}

	return out, nil
}

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
// wrapped pattern, which the user never typed.
func patternReason(err error) string {
	synErr, ok := err.(*syntax.Error) //nolint:errorlint // regexp.Compile returns it unwrapped
	if !ok {
		return "not a valid pattern"
	}
	switch synErr.Code {
	case syntax.ErrInvalidPerlOp:
		return "lookahead and lookbehind are not supported"
	case syntax.ErrInvalidEscape:
		if len(synErr.Expr) == 2 && synErr.Expr[0] == '\\' && strings.ContainsRune("123456789", rune(synErr.Expr[1])) {
			return "backreferences are not supported"
		}
	default:
	}

	return fmt.Sprint(synErr.Code)
}
