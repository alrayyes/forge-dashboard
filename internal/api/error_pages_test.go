package api_test

import (
	"io"
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

	h := api.NewStaticHandler(errorPageFixture(), false)

	resp := get(h, "/nope", "")

	assert.Equal(t, http.StatusNotFound, resp.Code, "a friendly page must not be a soft 404")
	assert.Contains(t, resp.Body.String(), "Page not found")
	assert.Contains(t, resp.Header().Get("Content-Type"), "text/html")
	assert.Equal(t, "no-cache", resp.Header().Get("Cache-Control"))
	assert.Empty(t, resp.Header().Get("ETag"))
}

func TestStatic_MissingHashedAsset_StaysAnUncachedPlain404(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(errorPageFixture(), false)

	resp := get(h, "/_app/immutable/entry/gone.js", "")

	assert.Equal(t, http.StatusNotFound, resp.Code)
	assert.NotContains(t, resp.Body.String(), "Page not found", "a script request must not receive HTML")
	assert.NotContains(t, resp.Header().Get("Cache-Control"), "immutable")
}

func TestStatic_UnknownPath_WithoutAnErrorPageFile_KeepsThePlain404(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(staticFixture(), false)

	resp := get(h, "/nope", "")

	assert.Equal(t, http.StatusNotFound, resp.Code)
}

func TestStatic_HeadOnUnknownPath_Is404WithoutABody(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(errorPageFixture(), false)
	req := httptest.NewRequest(http.MethodHead, "/nope", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Empty(t, rec.Body.String())
}

func TestRecoverPanics_APanickingHandler_AnswersThe500PageWithNoInternals(t *testing.T) {
	t.Parallel()

	h := api.RecoverPanics(errorPageFixture(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
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

	h := api.RecoverPanics(errorPageFixture(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))

	resp := get(h, "/api/v1/dashboard", "")

	assert.Equal(t, http.StatusInternalServerError, resp.Code)
	assert.Contains(t, resp.Header().Get("Content-Type"), "application/json")
	assert.JSONEq(t, `{"error":"internal error"}`, resp.Body.String())
}

func TestRecoverPanics_NoPanic_PassesThrough(t *testing.T) {
	t.Parallel()

	h := api.RecoverPanics(errorPageFixture(), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))

	assert.Equal(t, http.StatusTeapot, get(h, "/", "").Code)
}

func TestRecoverPanics_AbortHandler_IsNotSwallowed(t *testing.T) {
	t.Parallel()

	h := api.RecoverPanics(errorPageFixture(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	}))

	require.PanicsWithValue(t, http.ErrAbortHandler, func() { get(h, "/", "") })
}

func TestServer_UnknownAPIPath_IsJSONNotThePage(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := testClient(t).Get(srv.URL + "/api/does-not-exist")
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	assert.Contains(t, resp.Header.Get("Content-Type"), "application/json")
}

func TestStatic_TheErrorPageFilesThemselves_NeverAnswer200(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(errorPageFixture(), false)

	for _, path := range []string{"/404.html", "/500.html"} {
		resp := get(h, path, "")

		assert.Equal(t, http.StatusNotFound, resp.Code, path)
		assert.Contains(t, resp.Body.String(), "Page not found", path)
		assert.Equal(t, "no-cache", resp.Header().Get("Cache-Control"), path)
	}
}

// The prerendered pages ship with scripting off and anyone can trigger one, so
// they never carry the running version (#4427).

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

// The real server, with the built pages embedded: a request for an unknown
// address gets the 404 page, and nothing in it names the running release.
func TestErrorPages_Served_NeverShowTheVersion(t *testing.T) {
	t.Parallel()

	if _, err := fs.Stat(api.StaticFiles, "static/404.html"); err != nil {
		t.Skip("404.html isn't embedded: run bun run build:web first")
	}

	srv := newTestServer(t)
	resp, err := testClient(t).Get(srv.URL + "/no-such-page") //nolint:noctx // test against a local server
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	assert.Contains(t, string(body), `id="footer-version"`) // the page is the real one
	assert.NotContains(t, string(body), testVersion)
	assert.NotContains(t, string(body), "dev build")
}

func TestErrorPages_KeepStatusTypeAndCaching(t *testing.T) {
	t.Parallel()

	notFound := get(api.NewStaticHandler(footerPageFixture(), false), "/nope", "")
	assert.Equal(t, http.StatusNotFound, notFound.Code)
	assert.Equal(t, "text/html; charset=utf-8", notFound.Header().Get("Content-Type"))
	assert.Equal(t, "no-cache", notFound.Header().Get("Cache-Control"))

	crashed := get(api.RecoverPanics(footerPageFixture(), panicking()), "/issues.html", "")
	assert.Equal(t, http.StatusInternalServerError, crashed.Code)
	assert.Equal(t, "text/html; charset=utf-8", crashed.Header().Get("Content-Type"))
	assert.Equal(t, "no-store", crashed.Header().Get("Cache-Control"))
}
