package api

import (
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"runtime/debug"
	"strings"
)

// The dashboard's own error pages (#1175), built by the frontend as 404.html
// and 500.html. Each answers its real status code: a friendly page served as
// 200 is a soft 404 to a crawler. Neither is cached for long, and the 5xx
// page is not stored at all, so a visitor doesn't keep seeing a crash after
// the fix (rules/error-pages.md).
const (
	notFoundPage    = "404.html"
	serverErrorPage = "500.html"
)

// withNotFoundPage swaps the file server's bare "404 page not found" for the
// app's own page. Only for a path a person would type: a missing script,
// stylesheet or image stays a plain 404, since HTML in place of a script is
// worse than nothing. Without a 404.html in the build the plain answer stays.
func withNotFoundPage(fsys fs.FS, next http.Handler) http.Handler {
	page, err := fs.ReadFile(fsys, notFoundPage)
	if err != nil {
		return next
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !asksForAPage(r.URL.Path) {
			next.ServeHTTP(w, r)

			return
		}
		next.ServeHTTP(&notFoundWriter{ResponseWriter: w, page: page, head: r.Method == http.MethodHead}, r)
	})
}

// asksForAPage reports whether urlPath looks like navigation rather than an
// asset request: no extension, or .html.
func asksForAPage(urlPath string) bool {
	if strings.HasPrefix(urlPath, "/"+immutablePrefix) {
		return false
	}
	ext := path.Ext(path.Clean(urlPath))

	return ext == "" || ext == ".html"
}

// notFoundWriter replaces a 404 from the file server with the app's page.
type notFoundWriter struct {
	http.ResponseWriter

	page     []byte
	head     bool
	replaced bool
}

func (w *notFoundWriter) WriteHeader(status int) {
	if status != http.StatusNotFound {
		w.ResponseWriter.WriteHeader(status)

		return
	}
	w.replaced = true
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", cacheRevalidate)
	h.Del("X-Content-Type-Options")
	h.Del("Content-Length")
	w.ResponseWriter.WriteHeader(http.StatusNotFound)
	if !w.head {
		_, _ = w.ResponseWriter.Write(w.page)
	}
}

// Write drops the file server's own 404 text once the page has been sent.
func (w *notFoundWriter) Write(b []byte) (int, error) {
	if w.replaced {
		return len(b), nil
	}

	return w.ResponseWriter.Write(b) //nolint:wrapcheck // a pass-through writer must not alter the error
}

func (w *notFoundWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// recoverPanics answers a panicking handler with a 500 instead of the empty
// reply net/http gives. The panic and its stack go to the log, never to the
// visitor. A browser navigation gets the app's 500 page, an API call the JSON
// error its callers expect. http.ErrAbortHandler is the sanctioned way to cut
// a response short, so it passes through.
func recoverPanics(fsys fs.FS, next http.Handler) http.Handler {
	page, _ := fs.ReadFile(fsys, serverErrorPage)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tracked := &startedWriter{ResponseWriter: w}
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			if err, ok := rec.(error); ok && errors.Is(err, http.ErrAbortHandler) {
				panic(rec)
			}
			slog.Error("handler panicked", "method", r.Method, "path", r.URL.Path, "panic", rec, "stack", string(debug.Stack()))
			if !tracked.started {
				writeServerError(w, r, page)
			}
		}()
		next.ServeHTTP(tracked, r)
	})
}

// writeServerError sends the 500 answer fit for the request: JSON for the
// API, the app's page for a browser, plain text when the build has none.
func writeServerError(w http.ResponseWriter, r *http.Request, page []byte) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case strings.HasPrefix(r.URL.Path, "/api/"):
		writeJSON(w, http.StatusInternalServerError, errorBody("internal error"))
	case page != nil:
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		if r.Method != http.MethodHead {
			_, _ = w.Write(page)
		}
	default:
		http.Error(w, "Something went wrong", http.StatusInternalServerError)
	}
}

// startedWriter notes whether a response has begun, after which a 500 can no
// longer be sent.
type startedWriter struct {
	http.ResponseWriter

	started bool
}

func (w *startedWriter) WriteHeader(status int) {
	w.started = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *startedWriter) Write(b []byte) (int, error) {
	w.started = true

	return w.ResponseWriter.Write(b) //nolint:wrapcheck // a pass-through writer must not alter the error
}

// Flush keeps the SSE streams working through the wrapper.
func (w *startedWriter) Flush() {
	w.started = true
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *startedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
