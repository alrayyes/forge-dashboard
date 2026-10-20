package api_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// The repository's own logo has to survive dashboard.Repo -> repoStatus ->
// JSON, and stay off the wire when the repo has none (no placeholder).
func TestDashboard_RepoStatus_SerializesLogoURLOnlyWhenThereIsOne(t *testing.T) {
	t.Parallel()

	with := repoStatusJSON(t, dashboard.Repo{
		Forge:    dashboard.ForgeForgejo,
		FullName: "alrayyes/a",
		LogoURL:  "https://git.example/repo-avatars/abc",
	})
	without := repoStatusJSON(t, dashboard.Repo{Forge: dashboard.ForgeForgejo, FullName: "alrayyes/b"})

	assert.Equal(t, "https://git.example/repo-avatars/abc", with["logoUrl"])
	assert.NotContains(t, without, "logoUrl")
}
