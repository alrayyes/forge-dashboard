package api_test

import (
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

	resp := get(h, "/api/dashboard", "")

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
	resp, err := http.Get(srv.URL + "/api/does-not-exist")
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	assert.Contains(t, resp.Header.Get("Content-Type"), "application/json")
}
