package api

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// Avatars and repository logos load through the image proxy too (#3467), so
// the GitHub hosts they live on are on its list.
func TestGithubImageHosts_CoverAvatarsAndRepositoryLogos(t *testing.T) {
	t.Parallel()
	assert.Contains(t, githubImageHosts, "avatars.githubusercontent.com")
	assert.Contains(t, githubImageHosts, "repository-images.githubusercontent.com")
}
