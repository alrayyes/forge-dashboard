package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// accessLogMiddleware logs one structured line per request, after the
// handler returns rather than before — the real status code and duration
// aren't known until then (#371). Wraps the whole mux from the outside,
// specifically outside auth.RequireAuth: a rejected or unauthenticated
// request still gets logged, which is what actually lets repeated failed
// auth attempts show up here at all.
//
// Never logs a Cookie or Authorization header, a raw query string, or a
// request/response body — method, path (no query), status, duration and
// remote address are the fields logged unconditionally; username is added
// once auth.RequireAuth (further in) resolves one, via the shared slot
// auth.WithAccessLogUsername sets up.
func accessLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		ctx, usernameSlot := auth.WithAccessLogUsername(r.Context())
		r = r.WithContext(ctx)

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		duration := time.Since(start)
		level := accessLogLevel(r.URL.Path, rec.status)

		attrs := []any{
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", duration.Milliseconds(),
			"remote_addr", r.RemoteAddr,
		}
		if *usernameSlot != "" {
			attrs = append(attrs, "username", *usernameSlot)
		}
		slog.Log(r.Context(), level, "http request", attrs...)
	})
}

// accessLogLevel picks the level a request's own outcome earns: 5xx is a
// real failure, 4xx is a client-caused rejection worth noticing but not
// alarming over, everything else is routine. /healthz gets downgraded to
// Debug on a normal (non-error) response — liveness-probe traffic hits it
// constantly, and logging that at Info would drown out everything real; a
// genuine failure there still surfaces at its own level, unchanged.
func accessLogLevel(path string, status int) slog.Level {
	switch {
	case status >= http.StatusInternalServerError:
		return slog.LevelError
	case status >= http.StatusBadRequest:
		return slog.LevelWarn
	case path == "/healthz":
		return slog.LevelDebug
	default:
		return slog.LevelInfo
	}
}

// statusRecorder captures the status code a handler wrote — an
// http.ResponseWriter doesn't expose it otherwise. Defaults to 200: a
// handler that only calls Write without an explicit WriteHeader gets an
// implicit 200 from the real net/http server, and this mirrors that.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(status int) {
	s.status = status
	s.ResponseWriter.WriteHeader(status)
}

// Flush implements http.Flusher by delegating to the wrapped
// ResponseWriter, if it supports it — handleDashboardStream's own SSE
// handler type-asserts for this on whatever http.ResponseWriter it's
// handed, and embedding the interface alone doesn't promote a method the
// embedded *value*'s concrete type has but the interface itself doesn't
// declare (an http.ResponseWriter wrapper is exactly this trap; the real
// server's ResponseWriter satisfies Flusher, but wrapping it in a plain
// struct like this one silently hides that from a caller's own type
// assertion unless the wrapper forwards it explicitly, same as this one
// now does).
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
