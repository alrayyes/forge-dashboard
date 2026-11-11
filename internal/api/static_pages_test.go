package api_test

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// What the built frontend ships, read from the files the binary embeds. These
// used to run in a browser, which they never needed: each one is a statement
// about a file, not about how a browser draws it.

var (
	publicPages   = []string{"login.html", "changelog.html", "disclaimer.html", "privacy.html"}
	signedInPages = []string{"index.html", "pull-requests.html", "issues.html", "insights.html", "webhooks.html", "settings.html"}

	metaDescription = regexp.MustCompile(`<meta name="description" content="([^"]*)"`)
	fontPreload     = regexp.MustCompile(`<link[^>]*rel="preload"[^>]*as="font"[^>]*>`)
	hrefAttr        = regexp.MustCompile(`href="([^"]*)"`)
	fontFace        = regexp.MustCompile(`@font-face\{[^}]*\}`)
	// What a browser fetches to render: a stylesheet or script tag, an @import
	// or a url(). A link to github.com in the text is not a request.
	externalLoad = regexp.MustCompile(`(?:<link[^>]*href|<script[^>]*src)="(?:https?:)?//|@import|url\(["']?(?:https?:)?//`)
)

func builtPage(t *testing.T, name string) string {
	t.Helper()

	body, err := os.ReadFile(filepath.Join("static", name))
	require.NoError(t, err, "run `bun run build:web` first")

	return string(body)
}

func servedText(t *testing.T, srv string, path string) string {
	t.Helper()

	resp, err := testClient(t).Get(srv + path) //nolint:noctx // test against a local server
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode, path)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	return string(body)
}

// style.css was once served as written, comments and all, and Lighthouse
// flagged it as unminified (#1135).
func TestStaticPages_StyleCSSIsServedMinified(t *testing.T) {
	t.Parallel()

	css := servedText(t, newTestServer(t).URL, "/style.css")

	assert.NotContains(t, css, "/*")
	assert.Less(t, strings.Count(css, "\n")+1, 20)
	assert.Contains(t, css, "--bg:")
}

// The shared sheet loads ahead of every page's own styles (#1135).
func TestStaticPages_LinkStyleCSSBeforeTheirOwnStyles(t *testing.T) {
	t.Parallel()

	html := servedText(t, newTestServer(t).URL, "/login.html")
	sheet := strings.Index(html, `href="/style.css"`)
	inline := strings.Index(html, "<style")

	require.Positive(t, sheet+1)
	require.Positive(t, inline+1)
	assert.Less(t, sheet, inline)
}

// Lighthouse blamed the footer's layout shifts on the Plex fonts arriving
// after first paint; a preload link starts the download with the HTML (#1255).
func TestStaticPages_PreloadTheLatinFontsTheFirstPaintUses(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)

	for _, path := range []string{"/login.html", "/disclaimer.html"} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			html := servedText(t, srv.URL, path)
			preloads := fontPreload.FindAllString(html, -1)

			require.NotEmpty(t, preloads)
			joined := strings.Join(preloads, "\n")
			for _, tag := range preloads {
				assert.Contains(t, tag, `type="font/woff2"`)
				assert.Contains(t, tag, "crossorigin")
				assert.Regexp(t, `latin-(400|600)-normal`, tag)
				// The file it names has to be there, or the preload is a 404.
				href := hrefAttr.FindStringSubmatch(tag)[1]
				resp, err := testClient(t).Get(srv.URL + "/" + strings.TrimPrefix(href, "./")) //nolint:noctx // test against a local server
				require.NoError(t, err)
				_ = resp.Body.Close()
				assert.Equal(t, http.StatusOK, resp.StatusCode, href)
			}
			assert.Contains(t, joined, "ibm-plex-sans-latin-400")
			assert.Contains(t, joined, "ibm-plex-mono-latin-400")
		})
	}
}

// The fonts are served by the app itself: no page waits on, or sends a
// visitor's address to, a third-party host just to render text (#797). Every
// face swaps in, so text shows before the font arrives.
func TestStaticPages_FontsAndStylesComeFromTheApp(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	css := servedText(t, srv.URL, "/style.css")

	faces := fontFace.FindAllString(css, -1)
	for _, name := range []string{"login.html", "pull-requests.html"} {
		page := builtPage(t, name)
		faces = append(faces, fontFace.FindAllString(page, -1)...)
		assert.Empty(t, externalLoad.FindAllString(page, -1), name)
	}
	assert.Empty(t, externalLoad.FindAllString(css, -1))
	require.NotEmpty(t, faces)
	for _, face := range faces {
		assert.Contains(t, face, "font-display:swap", face)
	}
}

// Lighthouse's SEO audit wants a description on every page, and a search
// result or link preview reads it: a sentence about the page, not the product
// name repeated (#1135).
func TestStaticPages_EveryPageDescribesItselfDifferently(t *testing.T) {
	t.Parallel()

	seen := map[string]string{}
	for _, name := range append(append([]string{}, publicPages...), signedInPages...) {
		match := metaDescription.FindStringSubmatch(builtPage(t, name))
		require.NotNil(t, match, "%s has no description", name)
		assert.Greater(t, len(match[1]), 20, name)
		other, dup := seen[match[1]]
		assert.False(t, dup, "%s repeats the description of %s", name, other)
		seen[match[1]] = name
	}
}

// An internal tool stays out of search results (#1285). The header test covers
// every route; this checks the built pages carry the meta tag too, which
// survives a proxy that strips the header.
func TestStaticPages_SayNoindexInTheHTML(t *testing.T) {
	t.Parallel()

	for _, name := range append(append([]string{}, publicPages...), signedInPages...) {
		assert.Regexp(t, `<meta name="robots" content="noindex, nofollow"`, builtPage(t, name), name)
	}
}
