## 1. Domain model

- [ ] 1.1 Add `ForgeErrorKind` (`type X string` + const block:
      `ForgeErrorUnreachable`, `ForgeErrorUnauthorized`,
      `ForgeErrorNotFound`, `ForgeErrorRateLimited`, `ForgeErrorUnknown`)
      to `internal/dashboard/model.go`, mirroring `CIStatus`/`MergeStatus`.
- [ ] 1.2 Add `ForgeHealth.ErrorKind ForgeErrorKind` (json `errorKind,omitempty`)
      to `internal/dashboard/model.go`.
- [ ] 1.3 Add `dashboard.ClientError{Kind ForgeErrorKind, Err error}` with
      `Error() string` and `Unwrap() error` to `internal/dashboard/model.go`.

## 2. Forgejo classification

- [ ] 2.1 In `internal/forgejo/client.go`'s `forgejoError`, classify via
      `resp == nil` → `Unreachable`, else `resp.StatusCode` (401/403 →
      `Unauthorized`, 404 → `NotFound`, 429 → `RateLimited`, default →
      `Unknown`), and return the result wrapped in `dashboard.ClientError`.
- [ ] 2.2 In `internal/dashboard/generic_source.go`'s `GenericSource.Fetch`,
      unwrap `dashboard.ClientError` via `errors.As` when building
      `ForgeHealth` from a `ForgeClient` error, populating `ErrorKind`.

## 3. GitHub classification

- [ ] 3.1 Add a `kind dashboard.ForgeErrorKind` field to `apiError` in
      `internal/github/client.go`.
- [ ] 3.2 Add `Extensions struct{ Type string }` to `graphqlErrorEntry`
      (`internal/github/client.go`).
- [ ] 3.3 In `graphqlDo`, wrap the transport-failure branch
      (`c.httpClient.Do(req)` returning a bare `err`) in
      `&apiError{msg: "github: POST /graphql: " + err.Error(), kind:
    dashboard.ForgeErrorUnreachable}` instead of returning it bare.
- [ ] 3.4 In `graphqlDo`'s non-2xx branch, classify via `resp.StatusCode`
      the same mapping as Forgejo's, and set `kind` on the returned
      `apiError`.
- [ ] 3.5 In `graphqlDo`'s 200-with-`errors`-array branch, classify via
      `rateLimitShortMessage` first (existing header check), else
      `envelope.Errors[0].Extensions.Type` (`FORBIDDEN`/`UNAUTHENTICATED`/
      `INSUFFICIENT_SCOPES` → `Unauthorized`, `NOT_FOUND` → `NotFound`,
      `RATE_LIMITED` → `RateLimited`, else → `Unknown`), and set `kind` on
      the returned `apiError`.
- [ ] 3.6 In `fetchViaGraphQL`'s `errors.As(err, &apiErr)` site, also read
      `apiErr.kind` into `health.ErrorKind`.
- [ ] 3.7 Change `restError` to build and return `&apiError{msg, kind}`
      instead of plain `fmt.Errorf`: `*ghsdk.RateLimitError`/
      `*ghsdk.AbuseRateLimitError` → `RateLimited`; `*ghsdk.ErrorResponse`
      → classify via `errResp.Response.StatusCode`, same mapping; the
      bare catch-all → `Unreachable`.
- [ ] 3.8 In `fetchPublicViaREST`'s error site, add an
      `errors.As(err, &apiErr)` extraction (mirroring `fetchViaGraphQL`'s)
      to populate `health.ErrorKind`.

## 4. API contract

- [ ] 4.1 Add a `ForgeErrorKind` enum schema to `api/openapi.yaml`
      (`unreachable`/`unauthorized`/`not_found`/`rate_limited`/`unknown`).
- [ ] 4.2 Add an optional `errorKind` property to `ForgeHealth` in
      `api/openapi.yaml`, referencing the new schema.
- [ ] 4.3 Run `bun run lint:api` and confirm it passes.

## 5. Frontend

- [ ] 5.1 In `internal/api/static/app.js`'s `renderForgeHealth`, add a
      `HEADLINE` lookup keyed by `ForgeErrorKind`, with the copy from
      design.md (the `unreachable` case mentioning the refresh button).
- [ ] 5.2 Replace `chip.title = f.error` and the `.forge-health-error`
      span with the friendly headline plus a `<details><summary>Show
    details</summary>...</details>` disclosure containing the raw
      `f.error` text.
- [ ] 5.3 Add/adjust styling in `internal/api/static/style.css` for the
      headline and disclosure, reusing the existing `--critical`/`--ink-2`/
      `--ink-3` token set.

## 6. Tests

- [ ] 6.1 Add Go tests covering the classification at each of the three
      error-construction sites (Forgejo status codes, GitHub GraphQL
      status/extension-type/transport-failure, GitHub REST SDK error
      types), including the fallback-to-`Unknown` case.
- [ ] 6.2 Rewrite `tests/dashboard.spec.js:67-100`'s existing test (which
      asserts the raw error string is shown verbatim as primary text) to
      match the new behavior: friendly headline visible by default, raw
      string visible only after opening the disclosure.
- [ ] 6.3 Run `go build ./...`, `go vet ./...`, `go test ./...`.
- [ ] 6.4 Rebuild the binary and run the full `bunx playwright test`
      suite against a fresh DB.
- [ ] 6.5 Run `bun run lint:js`, `lint:api`, `lint:md`, `lint:prose`,
      `lint:mechanics`, `format:check`.
