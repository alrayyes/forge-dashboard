package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func TestIsBotManagedPR_ReleasePleaseLabel_ReturnsTrue(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{
		Author: "someone",
		Labels: []dashboard.Label{{Name: "autorelease: pending"}},
	}

	assert.True(t, dashboard.IsBotManagedPR(pr))
}

func TestIsBotManagedPR_ReleasePleaseTaggedLabel_ReturnsTrue(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{
		Author: "someone",
		Labels: []dashboard.Label{{Name: "autorelease: tagged"}},
	}

	assert.True(t, dashboard.IsBotManagedPR(pr))
}

func TestIsBotManagedPR_DependabotAuthor_ReturnsTrue(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{Author: "app/dependabot"}

	assert.True(t, dashboard.IsBotManagedPR(pr))
}

func TestIsBotManagedPR_RenovateAppAuthor_ReturnsTrue(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{Author: "app/renovate"}

	assert.True(t, dashboard.IsBotManagedPR(pr))
}

func TestIsBotManagedPR_RenovateClassicBotAuthor_ReturnsTrue(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{Author: "renovate[bot]"}

	assert.True(t, dashboard.IsBotManagedPR(pr))
}

func TestIsBotManagedPR_OrdinaryHumanAuthorNoLabels_ReturnsFalse(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{
		Author: "alrayyes",
		Labels: []dashboard.Label{{Name: "enhancement"}},
	}

	assert.False(t, dashboard.IsBotManagedPR(pr))
}
