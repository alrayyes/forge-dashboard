package api

import (
	"context"
	"errors"
	"log/slog"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Avatars and repository logos load through the image proxy too (#3467), so
// the GitHub hosts they live on are on its list.
func TestGithubImageHosts_CoverAvatarsAndRepositoryLogos(t *testing.T) {
	t.Parallel()
	assert.Contains(t, githubImageHosts, "avatars.githubusercontent.com")
	assert.Contains(t, githubImageHosts, "repository-images.githubusercontent.com")
}

// Which host each forge's proxy takes is decided by the host list alone, so
// these run on https with a public-looking name and a fetch that is cancelled
// before it dials: only the list can have answered. The passing address is the
// control that shows the refusals are about the host.
func TestImageProxyFor_TakesEachForgesOwnHostsOnly(t *testing.T) {
	t.Parallel()
	creds := settings.Credentials{ForgejoURL: "https://git.example", ForgejoToken: "t"}
	const (
		forgejoOwn = "https://git.example/avatars/abc"
		ghAvatar   = "https://avatars.githubusercontent.com/u/1?v=4"
		ghLogo     = "https://repository-images.githubusercontent.com/1/logo"
		stranger   = "https://evil.test/a.png"
	)
	for _, tc := range []struct {
		forge, raw string
		listed     bool
	}{
		{"forgejo", forgejoOwn, true},
		{"forgejo", ghAvatar, false},
		{"forgejo", ghLogo, false},
		{"forgejo", "https://github.com/user-attachments/assets/1", false},
		{"forgejo", stranger, false},
		{"github", ghAvatar, true},
		{"github", ghLogo, true},
		{"github", forgejoOwn, false},
		{"github", stranger, false},
	} {
		proxy, serr := imageProxyFor(Deps{}, tc.forge, creds)
		require.Nil(t, serr)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := proxy.Fetch(ctx, tc.raw)
		if tc.listed {
			assert.NotErrorIs(t, err, imageproxy.ErrHostNotAllowed, "%s takes %s", tc.forge, tc.raw)
		} else {
			assert.ErrorIs(t, err, imageproxy.ErrHostNotListed, "%s refuses %s", tc.forge, tc.raw)
		}
	}
}

// A plain host-list miss is routine, so it is logged at debug. Every other
// refusal, user info and a blocked address included, is a probe and stays a
// warning.
func TestImageRefusalLevel(t *testing.T) {
	t.Parallel()
	assert.Equal(t, slog.LevelDebug, imageRefusalLevel(imageproxy.ErrHostNotListed))
	for _, err := range []error{
		imageproxy.ErrHostNotAllowed,
		imageproxy.ErrUpstream,
		imageproxy.ErrNotImage,
		errors.New("anything else"),
	} {
		assert.Equal(t, slog.LevelWarn, imageRefusalLevel(err), "%v", err)
	}
}
