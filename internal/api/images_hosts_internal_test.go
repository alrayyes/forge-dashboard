package api

import (
	"context"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
)

// Avatars and repository logos load through the image proxy too (#3467), so
// the GitHub hosts they live on are on its list.
func TestGithubImageHosts_CoverAvatarsAndRepositoryLogos(t *testing.T) {
	t.Parallel()
	assert.Contains(t, githubImageHosts, "avatars.githubusercontent.com")
	assert.Contains(t, githubImageHosts, "repository-images.githubusercontent.com")
}

// The GitHub proxy accepts an avatar and a logo address. The fetch is cancelled
// before it dials, so only the host check can have answered.
func TestImageProxyFor_GithubAcceptsAvatarAndLogoAddresses(t *testing.T) {
	t.Parallel()
	proxy, serr := imageProxyFor("github", settings.Credentials{})
	assert.Nil(t, serr)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, raw := range []string{
		"https://avatars.githubusercontent.com/u/1?v=4",
		"https://repository-images.githubusercontent.com/1/logo",
	} {
		_, err := proxy.Fetch(ctx, raw)
		assert.NotErrorIs(t, err, imageproxy.ErrHostNotAllowed, raw)
	}
}
