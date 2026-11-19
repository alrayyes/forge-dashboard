package api

import (
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
		assert.Equal(t, "'self'", source,
			"img-src allows this server alone: a host belongs on the proxy's list, not here")
	}
	for _, host := range githubImageHosts(t) {
		assert.NotContains(t, contentSecurityPolicy, host, "the proxy fetches %s, the browser never does", host)
	}
}
