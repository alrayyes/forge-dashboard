package api

import (
	"context"
	"errors"
	"log/slog"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Avatars and repository logos load through the image proxy too (#3467), so
// the GitHub hosts they live on are on its list.
func TestGithubImageHosts_CoverAvatarsAndRepositoryLogos(t *testing.T) {
	t.Parallel()
	assert.Contains(t, githubImageHosts(t), "avatars.githubusercontent.com")
	assert.Contains(t, githubImageHosts(t), "repository-images.githubusercontent.com")
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
	assert.Equal(t, githubImageHosts(t), cfg.Hosts)
	assert.Contains(t, cfg.Hosts, "gist.githubusercontent.com", "gist images ride the same tokenless proxy (#3888)")
	assert.False(t, cfg.AllowLocal)
}

// githubImageHosts is every host GitHub's proxy may reach, as its capabilities
// name them.
func githubImageHosts(t *testing.T) []string {
	t.Helper()
	caps, ok := dashboard.CapabilitiesOf(dashboard.ForgeGitHub)
	require.True(t, ok)

	return append(append([]string{}, caps.ImageHosts...), caps.AvatarHosts...)
}

// A forge with a host policy of its own follows it with no edit outside the
// capability table (#4156): its image hosts, its avatar hosts and nothing else
// are taken, and no token goes with them.
func TestImageProxyForCapabilities_FollowsTheForgesFixedHosts(t *testing.T) {
	t.Parallel()
	caps := dashboard.ForgeCapabilities{
		ImageHosts:  []string{"img.third.example"},
		AvatarHosts: []string{"avatars.third.example"},
	}
	proxy, serr := imageProxyForCapabilities(Deps{}, "third", caps, settings.Credentials{ForgejoURL: "https://git.example", ForgejoToken: "t"})
	require.Nil(t, serr)
	cfg := proxy.Config()
	assert.ElementsMatch(t, []string{"img.third.example", "avatars.third.example"}, cfg.Hosts)
	assert.Empty(t, cfg.Token)
	assert.Empty(t, cfg.TokenHost)
	assert.Equal(t, "https", cfg.Scheme)
}

// A forge that names no host reads its images from the saved instance, which
// is also the only place its token goes.
func TestImageProxyForCapabilities_NoHostsMeansTheSavedInstance(t *testing.T) {
	t.Parallel()
	creds := settings.Credentials{Instances: map[string]settings.Instance{"third": {URL: "http://git.example:3000", Token: "t"}}}
	proxy, serr := imageProxyForCapabilities(Deps{}, "third", dashboard.ForgeCapabilities{}, creds)
	require.Nil(t, serr)
	cfg := proxy.Config()
	assert.Equal(t, []string{"git.example:3000"}, cfg.Hosts)
	assert.Equal(t, "t", cfg.Token)
	assert.Equal(t, "git.example:3000", cfg.TokenHost)
	assert.True(t, cfg.AllowLocal)

	_, serr = imageProxyForCapabilities(Deps{}, "third", dashboard.ForgeCapabilities{}, settings.Credentials{})
	require.NotNil(t, serr)
	assert.Equal(t, 400, serr.status)

	// Another forge's saved instance is not borrowed.
	_, serr = imageProxyForCapabilities(Deps{}, "third", dashboard.ForgeCapabilities{}, settings.Credentials{ForgejoURL: "https://git.example", ForgejoToken: "fj"})
	require.NotNil(t, serr)
}

func TestImageProxyFor_RefusesAForgeNobodyDescribed(t *testing.T) {
	t.Parallel()
	_, serr := imageProxyFor(Deps{}, "nowhere", settings.Credentials{})
	require.NotNil(t, serr)
	assert.Equal(t, 400, serr.status)
}

// Whether a link needs the signed lookup is the forge's prefix, not its name.
func TestIsSignedAttachment_FollowsTheForgesPrefix(t *testing.T) {
	t.Parallel()
	const prefix = "https://files.third.example/attachments/"
	for raw, want := range map[string]bool{
		prefix + "abc":                                 true,
		"https://files.third.example/other/abc":        false,
		"http://files.third.example/attachments/abc":   false,
		"https://FILES.third.example/attachments/abc":  true,
		"https://evil.example/attachments/abc":         false,
		"https://github.com/user-attachments/assets/1": false,
		"%zz": false,
		// A host that only ends with, starts with or contains the forge's host is someone else's.
		"https://evilfiles.third.example/attachments/x":                  false,
		"https://evil-files.third.example/attachments/x":                 false,
		"https://files.third.example.evil.example/attachments/x":         false,
		"https://sub.files.third.example/attachments/x":                  false,
		"https://evil.example/https://files.third.example/attachments/x": false,
		"https://files.third.example@evil.example/attachments/x":         false,
		"https://files.third.example:8443/attachments/x":                 false,
		"https://files.third.example:443/attachments/x":                  false,
		"https://files.third.example./attachments/x":                     false,
		"//files.third.example/attachments/x":                            false,
		"https:files.third.example/attachments/x":                        false,
	} {
		assert.Equal(t, want, isSignedAttachment(prefix, "", raw), raw)
	}
	assert.False(t, isSignedAttachment("", "", prefix+"abc"), "a forge with no prefix signs nothing")
	assert.True(t, isSignedAttachment(prefix, "http://127.0.0.1:9", "http://127.0.0.1:9/attachments/abc"), "a test origin stands in for the prefix's")
}

// A path that climbs out of the prefix, or hides a separator or dot segment
// behind an escape, must not get the signed lookup (#4247).
func TestIsSignedAttachment_RefusesPathsThatEscapeThePrefix(t *testing.T) {
	t.Parallel()
	const prefix = "https://files.third.example/attachments/"
	for raw, want := range map[string]bool{
		prefix + "abc":          true,
		prefix + "a/b/c.png":    true,
		prefix + "a%20b.png":    true,
		prefix + "../x":         false,
		prefix + "a/../../x":    false,
		prefix + "./abc":        false,
		prefix + "a/./b":        false,
		prefix + "%2e%2e/x":     false,
		prefix + "%2E%2E/x":     false,
		prefix + ".%2e/x":       false,
		prefix + "a%2f..%2fx":   false,
		prefix + "a%2Fb":        false,
		prefix + "%252e%252e/x": false,
		prefix + "a%252fb":      false,
		prefix + `..\x`:         false,
		prefix + "a%5cb":        false,
		prefix + "a%5Cb":        false,
		prefix + "a//b":         false,
		"https://files.third.example/Attachments/abc":    false,
		"https://files.third.example/ATTACHMENTS/abc":    false,
		"https://files.third.example/attachments/..":     false,
		"https://files.third.example/attachments/%2e%2e": false,
	} {
		assert.Equal(t, want, isSignedAttachment(prefix, "", raw), raw)
	}
}

// Gravatar and Libravatar serve an avatar a forge only links to, on hosts that
// are not the forge's. They are taken for an avatar and nothing else, by exact
// name over https, with no token and no private address.
func TestAvatarProxyFor_TakesFederatedAvatarHostsForAvatarsOnly(t *testing.T) {
	t.Parallel()
	creds := settings.Credentials{ForgejoURL: "https://git.example", ForgejoToken: "saved-token"}
	listed := []string{
		"https://gravatar.com/avatar/abc?s=64",
		"https://secure.gravatar.com/avatar/abc?s=64",
		"https://seccdn.libravatar.org/avatar/abc?s=64",
		"https://cdn.libravatar.org/avatar/abc?s=64",
	}
	refused := []string{
		"https://www.gravatar.com/avatar/abc",
		"https://gravatar.com.evil.test/avatar/abc",
		"https://evilgravatar.com/avatar/abc",
		"https://libravatar.org/avatar/abc",
		"https://evil.test/a.png",
		"http://secure.gravatar.com/avatar/abc",
		"https://user:pw@secure.gravatar.com/avatar/abc",
		"https://secure.gravatar.com:8443/avatar/abc",
	}
	for _, forge := range []string{"forgejo", "github"} {
		base, serr := imageProxyFor(Deps{}, forge, creds)
		require.Nil(t, serr)
		for _, raw := range listed {
			require.NotErrorIs(t, cancelledFetch(avatarProxyFor(base, imageAvatar, raw), raw), imageproxy.ErrHostNotAllowed, "%s avatar takes %s", forge, raw)
			require.ErrorIs(t, cancelledFetch(avatarProxyFor(base, imageEmbedded, raw), raw), imageproxy.ErrHostNotListed, "%s embedded refuses %s", forge, raw)
		}
		for _, raw := range refused {
			require.ErrorIs(t, cancelledFetch(avatarProxyFor(base, imageAvatar, raw), raw), imageproxy.ErrHostNotAllowed, "%s avatar refuses %s", forge, raw)
		}
	}
}

func TestAvatarProxyFor_FederatedProxyIsTokenlessPublicAndHttpsOnly(t *testing.T) {
	t.Parallel()
	creds := settings.Credentials{ForgejoURL: "http://git.example:3000", ForgejoToken: "saved-token"}
	base, serr := imageProxyFor(Deps{}, "forgejo", creds)
	require.Nil(t, serr)
	proxy := avatarProxyFor(base, imageAvatar, "https://secure.gravatar.com/avatar/abc")
	require.NotSame(t, base, proxy)
	cfg := proxy.Config()
	assert.ElementsMatch(t, []string{"gravatar.com", "secure.gravatar.com", "seccdn.libravatar.org", "cdn.libravatar.org"}, cfg.Hosts)
	assert.Equal(t, "https", cfg.Scheme, "https even when the saved instance is plain http")
	assert.Empty(t, cfg.Token)
	assert.Empty(t, cfg.TokenHost)
	assert.False(t, cfg.AllowLocal)
	assert.Equal(t, imageproxy.MaxAvatarBytes, imageAvatar.maxBytes())
	assert.Equal(t, 512<<10, imageproxy.MaxAvatarBytes)

	// The forge's own avatar keeps the forge's proxy.
	assert.Same(t, base, avatarProxyFor(base, imageAvatar, "http://git.example:3000/avatars/abc"))
	assert.Same(t, base, avatarProxyFor(base, imageAvatar, "%zz"))
}

func cancelledFetch(p *imageproxy.Proxy, raw string) error {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := p.Fetch(ctx, raw)

	return err //nolint:wrapcheck // the test reads the kind
}
