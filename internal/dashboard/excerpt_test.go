package dashboard_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func TestLogExcerpt(t *testing.T) {
	t.Parallel()

	manyLines := func(n int) string {
		var b strings.Builder
		for i := 1; i <= n; i++ {
			fmt.Fprintf(&b, "line %d\n", i)
		}

		return b.String()
	}

	tests := map[string]struct {
		tail    string
		partial bool
		want    string
	}{
		"keeps only the last lines":                  {tail: manyLines(30), want: strings.TrimSuffix(strings.Join(strings.Split(manyLines(30), "\n")[10:30], "\n"), "\n")},
		"a tail of blank lines is no excerpt":        {tail: "\n \t\n\r\n\n", want: ""},
		"blank lines between text are dropped":       {tail: "a\n\n\nb\n\n", want: "a\nb"},
		"a blank tail after text leaves the text":    {tail: "boom\n   \n\n", want: "boom"},
		"timestamps and colour codes are removed":    {tail: "2026-10-10T09:00:00.123Z \x1b[31mred\x1b[0m\n", want: "red"},
		"a partial tail drops its cut first line":    {tail: "tial line\nwhole\n", partial: true, want: "whole"},
		"a partial tail of one line keeps it":        {tail: "only", partial: true, want: "only"},
		"invalid utf-8 is dropped":                   {tail: "ok\xff\xfe\n", want: "ok"},
		"the empty tail is no excerpt":               {tail: "", want: ""},
		"a whole line is dropped before one is cut":  {tail: strings.Repeat("x", 1500) + "\n" + strings.Repeat("y", 1500) + "\n", want: strings.Repeat("y", 1500)},
		"one over-long line keeps its end":           {tail: strings.Repeat("a", 3000) + "END\n", want: strings.Repeat("a", dashboard.ExcerptBytes-3) + "END"},
		"a cut inside a multi-byte rune is repaired": {tail: strings.Repeat("é", 1500) + "a\n", want: strings.Repeat("é", 999) + "a"},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got := dashboard.LogExcerpt(tc.tail, tc.partial)

			assert.Equal(t, tc.want, got)
			assert.LessOrEqual(t, len(got), dashboard.ExcerptBytes)
		})
	}
}

func TestLogExcerpt_KeepsAtMostTheLastTwentyLines(t *testing.T) {
	t.Parallel()

	var b strings.Builder
	for i := 1; i <= 50; i++ {
		fmt.Fprintf(&b, "l%d\n", i)
	}

	lines := strings.Split(dashboard.LogExcerpt(b.String(), false), "\n")

	assert.Len(t, lines, dashboard.ExcerptLines)
	assert.Equal(t, "l31", lines[0])
	assert.Equal(t, "l50", lines[19])
}
