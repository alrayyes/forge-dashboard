package api_test

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The dashboard's own error pages (#1175): a real status code, the app's
// page as the body, never cached for long, and no internals in it.

func errorPageFixture() fstest.MapFS {
	fsys := staticFixture()
	fsys["404.html"] = &fstest.MapFile{Data: []byte("<title>Page not found</title>" + strings.Repeat("x", 2000))}
	fsys["500.html"] = &fstest.MapFile{Data: []byte("<title>Something went wrong</title>" + strings.Repeat("x", 2000))}

	return fsys
}

func TestStatic_UnknownPath_AnswersTheNotFoundPageWithA404(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(errorPageFixture(), false, "dev")

	resp := get(h, "/nope", "")

	assert.Equal(t, http.StatusNotFound, resp.Code, "a friendly page must not be a soft 404")
	assert.Contains(t, resp.Body.String(), "Page not found")
	assert.Contains(t, resp.Header().Get("Content-Type"), "text/html")
	assert.Equal(t, "no-cache", resp.Header().Get("Cache-Control"))
	assert.Empty(t, resp.Header().Get("ETag"))
}

func TestStatic_MissingHashedAsset_StaysAnUncachedPlain404(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(errorPageFixture(), false, "dev")

	resp := get(h, "/_app/immutable/entry/gone.js", "")

	assert.Equal(t, http.StatusNotFound, resp.Code)
	assert.NotContains(t, resp.Body.String(), "Page not found", "a script request must not receive HTML")
	assert.NotContains(t, resp.Header().Get("Cache-Control"), "immutable")
}

func TestStatic_UnknownPath_WithoutAnErrorPageFile_KeepsThePlain404(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(staticFixture(), false, "dev")

	resp := get(h, "/nope", "")

	assert.Equal(t, http.StatusNotFound, resp.Code)
}

func TestStatic_HeadOnUnknownPath_Is404WithoutABody(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(errorPageFixture(), false, "dev")
	req := httptest.NewRequest(http.MethodHead, "/nope", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Empty(t, rec.Body.String())
}

func TestRecoverPanics_APanickingHandler_AnswersThe500PageWithNoInternals(t *testing.T) {
	t.Parallel()

	h := api.RecoverPanics(errorPageFixture(), "dev", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom at /srv/app/secret.go:42")
	}))

	resp := get(h, "/issues.html", "")

	assert.Equal(t, http.StatusInternalServerError, resp.Code)
	assert.Contains(t, resp.Body.String(), "Something went wrong")
	assert.NotContains(t, resp.Body.String(), "boom")
	assert.NotContains(t, resp.Body.String(), "secret.go")
	assert.Equal(t, "no-store", resp.Header().Get("Cache-Control"))
}

func TestRecoverPanics_APanicOnAnAPIPath_AnswersJSON(t *testing.T) {
	t.Parallel()

	h := api.RecoverPanics(errorPageFixture(), "dev", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))

	resp := get(h, "/api/dashboard", "")

	assert.Equal(t, http.StatusInternalServerError, resp.Code)
	assert.Contains(t, resp.Header().Get("Content-Type"), "application/json")
	assert.JSONEq(t, `{"error":"internal error"}`, resp.Body.String())
}

func TestRecoverPanics_NoPanic_PassesThrough(t *testing.T) {
	t.Parallel()

	h := api.RecoverPanics(errorPageFixture(), "dev", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))

	assert.Equal(t, http.StatusTeapot, get(h, "/", "").Code)
}

func TestRecoverPanics_AbortHandler_IsNotSwallowed(t *testing.T) {
	t.Parallel()

	h := api.RecoverPanics(errorPageFixture(), "dev", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	}))

	require.PanicsWithValue(t, http.ErrAbortHandler, func() { get(h, "/", "") })
}

func TestServer_UnknownAPIPath_IsJSONNotThePage(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/does-not-exist")
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	assert.Contains(t, resp.Header.Get("Content-Type"), "application/json")
}

func TestStatic_TheErrorPageFilesThemselves_NeverAnswer200(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(errorPageFixture(), false, "dev")

	for _, path := range []string{"/404.html", "/500.html"} {
		resp := get(h, path, "")

		assert.Equal(t, http.StatusNotFound, resp.Code, path)
		assert.Contains(t, resp.Body.String(), "Page not found", path)
		assert.Equal(t, "no-cache", resp.Header().Get("Cache-Control"), path)
	}
}

// The prerendered pages ship with scripting off, so the footer's version
// can't be fetched in the browser. The server fills the empty placeholder
// span instead, from the version it was built with.

const footerPlaceholder = `<span id="footer-version"></span>`

func footerPageFixture() fstest.MapFS {
	fsys := staticFixture()
	fsys["404.html"] = &fstest.MapFile{Data: []byte("<title>Page not found</title><footer>GitHub</a> " + footerPlaceholder + " &#183; <a>Disclaimer</a></footer>")}
	fsys["500.html"] = &fstest.MapFile{Data: []byte("<title>Something went wrong</title><footer>GitHub</a> " + footerPlaceholder + " &#183; <a>Disclaimer</a></footer>")}

	return fsys
}

func panicking() http.Handler {
	return http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") })
}

func TestErrorPages_ReleaseBuild_ShowTheVersionLinkInTheFooter(t *testing.T) {
	t.Parallel()

	want := `GitHub</a> <span id="footer-version">&#183; <a class="mono" href="/changelog.html">v1.2.3</a></span> &#183; <a>Disclaimer</a>`

	notFound := get(api.NewStaticHandler(footerPageFixture(), false, "1.2.3"), "/nope", "")
	assert.Equal(t, http.StatusNotFound, notFound.Code)
	assert.Contains(t, notFound.Body.String(), want)

	crashed := get(api.RecoverPanics(footerPageFixture(), "1.2.3", panicking()), "/issues.html", "")
	assert.Equal(t, http.StatusInternalServerError, crashed.Code)
	assert.Contains(t, crashed.Body.String(), want)
}

func TestErrorPages_DevBuild_ShowTheDevLabelWithoutALink(t *testing.T) {
	t.Parallel()

	want := `<span id="footer-version">&#183; dev build</span>`

	notFound := get(api.NewStaticHandler(footerPageFixture(), false, "dev"), "/nope", "")
	assert.Contains(t, notFound.Body.String(), want)
	assert.NotContains(t, notFound.Body.String(), "/changelog.html")

	crashed := get(api.RecoverPanics(footerPageFixture(), "dev", panicking()), "/issues.html", "")
	assert.Contains(t, crashed.Body.String(), want)
	assert.NotContains(t, crashed.Body.String(), "/changelog.html")
}

func TestErrorPages_VersionWithHTMLCharacters_IsEscaped(t *testing.T) {
	t.Parallel()

	const evil = `1"><script>alert(1)</script>`

	notFound := get(api.NewStaticHandler(footerPageFixture(), false, evil), "/nope", "")
	assert.NotContains(t, notFound.Body.String(), "<script>")
	assert.Contains(t, notFound.Body.String(), "v1&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</a>")

	crashed := get(api.RecoverPanics(footerPageFixture(), evil, panicking()), "/issues.html", "")
	assert.NotContains(t, crashed.Body.String(), "<script>")
}

func TestErrorPages_WithTheVersion_KeepStatusTypeAndCaching(t *testing.T) {
	t.Parallel()

	notFound := get(api.NewStaticHandler(footerPageFixture(), false, "1.2.3"), "/nope", "")
	assert.Equal(t, http.StatusNotFound, notFound.Code)
	assert.Equal(t, "text/html; charset=utf-8", notFound.Header().Get("Content-Type"))
	assert.Equal(t, "no-cache", notFound.Header().Get("Cache-Control"))

	crashed := get(api.RecoverPanics(footerPageFixture(), "1.2.3", panicking()), "/issues.html", "")
	assert.Equal(t, http.StatusInternalServerError, crashed.Code)
	assert.Equal(t, "text/html; charset=utf-8", crashed.Header().Get("Content-Type"))
	assert.Equal(t, "no-store", crashed.Header().Get("Cache-Control"))
}

func TestInjectFooterVersion_WithoutThePlaceholder_ReportsIt(t *testing.T) {
	t.Parallel()

	_, err := api.InjectFooterVersion([]byte("<footer>no span</footer>"), "1.2.3")

	require.Error(t, err)
}

// Fails loudly when a frontend change renames or drops the placeholder, so
// the version never disappears from the error pages without anyone noticing.
// The pages exist once the web build has run (bun run build:web).
func TestEmbeddedErrorPages_CarryTheFooterPlaceholder(t *testing.T) {
	t.Parallel()

	static, err := fs.Sub(api.StaticFiles, "static")
	require.NoError(t, err)

	for _, name := range []string{"404.html", "500.html"} {
		page, err := fs.ReadFile(static, name)
		if err != nil {
			t.Skipf("%s isn't embedded: run bun run build:web first", name)
		}

		for _, version := range []string{"dev", "1.2.3"} {
			out, err := api.InjectFooterVersion(page, version)
			require.NoError(t, err, "%s lost the #footer-version placeholder; the server can't show the version", name)
			assert.NotEqual(t, string(page), string(out), name)
			assert.Contains(t, string(out), `<span id="footer-version">&#183; `, name)

			// Only the span's content may change: the separator before it and
			// everything after stay as the frontend rendered them.
			assert.Equal(t, stripFooterSpan(string(page)), stripFooterSpan(string(out)), name)
		}
	}
}

func stripFooterSpan(page string) string {
	start := strings.Index(page, `<span id="footer-version">`)
	end := start + strings.Index(page[start:], "</span>")

	return page[:start] + page[end:]
}
