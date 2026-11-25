package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResolveGitHubAppSlug_AcceptsWhatGitHubAllows(t *testing.T) {
	t.Parallel()

	slug, err := resolveGitHubAppSlug("forge-board-2")

	require.NoError(t, err)
	assert.Equal(t, "forge-board-2", slug)
}

func TestResolveGitHubAppSlug_UnsetIsFine(t *testing.T) {
	t.Parallel()

	slug, err := resolveGitHubAppSlug("")

	require.NoError(t, err)
	assert.Empty(t, slug)
}

func TestResolveGitHubAppSlug_RefusesAnythingThatCouldChangeTheLink(t *testing.T) {
	t.Parallel()

	for name, raw := range map[string]string{
		"a slash":     "evil/../x",
		"a space":     "a b",
		"a query":     "a?b=c",
		"a full link": "https://github.com/apps/x",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			_, err := resolveGitHubAppSlug(raw)

			require.Error(t, err)
			assert.Contains(t, err.Error(), "GITHUB_APP_SLUG")
		})
	}
}
