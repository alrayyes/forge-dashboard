package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGenericSource_Fetch_CarriesTheRepoLogoToTheRepo(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClient{
		repos: []dashboard.RepoRef{
			{FullName: "alrayyes/a", Owner: "alrayyes", Name: "a", LogoURL: "https://git.example/repo-avatars/abc"},
			{FullName: "alrayyes/b", Owner: "alrayyes", Name: "b"},
		},
	}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	result := source.Fetch(t.Context())

	require.Len(t, result.Repos, 2)
	assert.Equal(t, "https://git.example/repo-avatars/abc", result.Repos[0].LogoURL)
	assert.Empty(t, result.Repos[1].LogoURL)
}
