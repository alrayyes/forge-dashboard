package api

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The Content-Security-Policy and the image proxy describe one rule from two
// ends (#3467): the browser may load an image from this server only, and this
// server fetches it from the proxy's hosts. They are checked against each
// other here so one can't move without the other.

func imgSrcSources(t *testing.T) []string {
	t.Helper()
	for directive := range strings.SplitSeq(contentSecurityPolicy, ";") {
		fields := strings.Fields(directive)
		if len(fields) > 0 && fields[0] == "img-src" {
			return fields[1:]
		}
	}
	require.Fail(t, "the policy has no img-src")

	return nil
}

func TestContentSecurityPolicy_ImgSrcNamesNoHostTheProxyReaches(t *testing.T) {
	t.Parallel()
	sources := imgSrcSources(t)
	require.NotEmpty(t, sources)
	for _, source := range sources {
		assert.Contains(t, []string{"'self'", "data:"}, source,
			"img-src allows this server and inline data only: a host belongs on the proxy's list, not here")
	}
	for _, host := range githubImageHosts {
		assert.NotContains(t, contentSecurityPolicy, host, "the proxy fetches %s, the browser never does", host)
	}
}

var githubUserContentHost = regexp.MustCompile(`'([a-z-]+\.githubusercontent\.com|github\.com)'`)

// The page decides what to ask the proxy for from its own copy of the GitHub
// hosts. A host it asks for that the proxy refuses is a broken picture.
func TestGithubImageHosts_CoverEveryHostThePageSendsThroughTheProxy(t *testing.T) {
	t.Parallel()
	for _, file := range []string{"../../web/src/lib/image-source.ts", "../../web/src/lib/avatar.ts"} {
		src, err := os.ReadFile(file) //nolint:gosec // a fixed path to a source file in this repo
		require.NoError(t, err)
		found := githubUserContentHost.FindAllStringSubmatch(string(src), -1)
		require.NotEmpty(t, found, file)
		for _, m := range found {
			assert.Contains(t, githubImageHosts, m[1], "%s sends %s through the proxy", file, m[1])
		}
	}
}
