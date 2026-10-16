package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTitlePatterns_MatchAnywhereIgnoringCase(t *testing.T) {
	t.Parallel()

	patterns, err := dashboard.CompileTitlePatterns([]string{"^Weekly report", "stale"})
	require.NoError(t, err)

	assert.True(t, patterns.Matches("weekly REPORT for May"), "start anchor, any case")
	assert.True(t, patterns.Matches("Mark as STALE later"), "anywhere in the title")
	assert.False(t, patterns.Matches("The weekly report"), "the anchor holds")
}

func TestTitlePatterns_NoneMatchNothing(t *testing.T) {
	t.Parallel()

	patterns, err := dashboard.CompileTitlePatterns(nil)
	require.NoError(t, err)

	assert.False(t, patterns.Matches("anything"))
}

func TestCompileTitlePatterns_AnAlternationIsCaseInsensitiveOnBothSides(t *testing.T) {
	t.Parallel()

	patterns, err := dashboard.CompileTitlePatterns([]string{"foo|bar"})
	require.NoError(t, err)

	assert.True(t, patterns.Matches("BAR"))
}
