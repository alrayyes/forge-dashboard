# Tasks

## 1. Middleware

- [ ] 1.1 Add a `statusRecorder` wrapping `http.ResponseWriter` to capture the written status code (defaulting to 200 if `WriteHeader` is never called), and verify it correctly records both an explicit and an implicit status via a unit test
- [ ] 1.2 Add a logging middleware wrapping the whole mux (`http.Handler`), computing duration and calling `slog` at Error/Warn/Info per the response status, and verify one log line is emitted per request with the expected fields (`method`, `path`, `status`, `duration_ms`, `remote_addr`)
- [ ] 1.3 Wire the middleware into `NewMux`, wrapping the returned mux from the outside (so it sees requests `auth.RequireAuth` rejects too), and verify an unauthenticated request to a protected endpoint still produces a log entry

## 2. Field content and redaction

- [ ] 2.1 Add the signed-in username to the log entry when auth resolves, and verify it appears for an authenticated request and is absent for an anonymous one
- [ ] 2.2 Verify via test that neither the `Authorization` header, the `Cookie` header, nor the raw query string ever appears in a log entry, even when a request carries all three

## 3. Noise reduction

- [ ] 3.1 Log `/healthz` at Debug instead of Info (or exclude it), and verify a request to it doesn't appear in default (Info-level) output but does appear when the level is lowered to Debug

## 4. Verification

- [ ] 4.1 Run the full test suite and confirm no existing test asserts on stdout/stderr log format in a way this change would break
