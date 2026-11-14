package api

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
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

// A public gist's raw files are served from their own host (#3888). It is the
// same kind of content as raw.githubusercontent.com, so it's on the list, by
// exact name: a lookalike or a sibling host is refused.
func TestImageProxyFor_TakesGistRawHostExactly(t *testing.T) {
	t.Parallel()
	creds := settings.Credentials{ForgejoURL: "https://git.example", ForgejoToken: "t"}
	for _, tc := range []struct {
		forge, raw string
		listed     bool
	}{
		{"github", "https://gist.githubusercontent.com/o/1/raw/r/a.png", true},
		{"github", "https://gist.githubusercontent.com.evil.example/o/1/raw/r/a.png", false},
		{"github", "https://evilgist.githubusercontent.com/a.png", false},
		{"github", "https://gist.github.com/o/1/raw/a.png", false},
		{"forgejo", "https://gist.githubusercontent.com/o/1/raw/r/a.png", false},
	} {
		proxy, serr := imageProxyFor(Deps{}, tc.forge, creds)
		require.Nil(t, serr)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := proxy.Fetch(ctx, tc.raw)
		if tc.listed {
			assert.NotErrorIs(t, err, imageproxy.ErrHostNotListed, "%s takes %s", tc.forge, tc.raw)
		} else {
			assert.ErrorIs(t, err, imageproxy.ErrHostNotListed, "%s refuses %s", tc.forge, tc.raw)
		}
	}
}

// The page's list (web/src/lib/image-source.ts) decides which addresses are
// worth asking the server for; this list is the one that enforces. They are
// two copies, so a host the page offers that the server refuses would be a
// wasted round trip, and a drift goes unseen. Every page host must be on the
// server's list, and the page must offer every embedded-content host (all but
// the two that only avatars and repository logos use, which load by their own
// path).
func TestGithubImageHosts_WebListStaysInStep(t *testing.T) {
	t.Parallel()
	src, err := os.ReadFile(filepath.Join("..", "..", "web", "src", "lib", "image-source.ts"))
	require.NoError(t, err)
	block := regexp.MustCompile(`(?s)GITHUB_HOSTS = new Set\(\[(.*?)\]\)`).FindSubmatch(src)
	require.NotNil(t, block, "GITHUB_HOSTS not found in image-source.ts")
	var web []string
	for _, m := range regexp.MustCompile(`'([^']+)'`).FindAllSubmatch(block[1], -1) {
		web = append(web, string(m[1]))
	}
	avatarOnly := []string{"avatars.githubusercontent.com", "repository-images.githubusercontent.com"}
	var want []string
	for _, h := range githubImageHosts {
		if !slices.Contains(avatarOnly, h) {
			want = append(want, h)
		}
	}
	assert.ElementsMatch(t, want, web, "web GITHUB_HOSTS and githubImageHosts drifted")
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

// GitHub's attachment links carry their own signature, so the default proxy is
// built with no token and no token host. A token added here would be sent to
// the image host.
func TestImageProxyFor_GithubProxyCarriesNoToken(t *testing.T) {
	t.Parallel()
	creds := settings.Credentials{ForgejoURL: "https://git.example", ForgejoToken: "saved-token"}
	proxy, serr := imageProxyFor(Deps{}, "github", creds)
	require.Nil(t, serr)
	cfg := proxy.Config()
	assert.Empty(t, cfg.Token, "no token for the image host")
	assert.Empty(t, cfg.TokenHost, "no host the token could go to")
	assert.Equal(t, githubImageHosts, cfg.Hosts)
	assert.Contains(t, cfg.Hosts, "gist.githubusercontent.com", "gist images ride the same tokenless proxy (#3888)")
	assert.False(t, cfg.AllowLocal)
}
