package api

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// Saved patterns were valid when saved, so one that no longer compiles means
// the store was edited or the syntax changed. Its entry is unknown (#1677);
// the rest still count.
func TestTitleCounts_APatternThatNoLongerCompilesIsNullAndTheRestCount(t *testing.T) {
	t.Parallel()
	issues := []dashboard.Issue{{Title: "Weekly one"}, {Title: "Weekly two"}}

	got := titleCounts([]string{"weekly", "(", "zzz"}, issues, func(dashboard.Issue) bool { return false })

	assert.Equal(t, []*int{new(2), nil, new(0)}, got)
}
