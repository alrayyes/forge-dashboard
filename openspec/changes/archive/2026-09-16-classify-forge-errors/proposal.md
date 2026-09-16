## Why

`ForgeHealth.Error` is a raw, doubly-wrapped technical error string, shown
to the user verbatim as both a hover tooltip and visible text. It
conflates genuinely different problems — a temporary outage, a bad token,
a wrong instance URL, a rate limit — under one identical "unreachable"
treatment, with no indication of which one it is or what to do about it.
See [#229](https://github.com/alrayyes/forge-dashboard/issues/229) for the
acceptance criteria this was built against.

## What Changes

- Add a coarse `ForgeErrorKind` classification
  (`unreachable`/`unauthorized`/`not_found`/`rate_limited`/`unknown`) to
  `ForgeHealth`, mirroring `CIStatus`/`MergeStatus`'s existing pattern.
- Classify at each of the three points a client already builds its error —
  `internal/forgejo/client.go`'s `forgejoError`, `internal/github/client.go`'s
  GraphQL path and its REST-fallback `restError` — using the HTTP status
  code already reachable at each site today but currently unused.
- A new `dashboard.ClientError` type carries the classification from
  Forgejo's client back to the shared, forge-agnostic code that builds
  `ForgeHealth` from it (`internal/dashboard/generic_source.go`, the only
  path that needs a cross-package carrier since it can't see an
  unexported type from `internal/forgejo`) — the same "structured data
  alongside a message string, unwrapped via `errors.As`" idiom
  `apiError.rateLimit` already uses, generalized so it works across a
  package boundary without inverting the existing dependency direction
  (`internal/dashboard` is depended on by the two forge clients, never
  the reverse). GitHub never goes through this path — both its
  `Source` methods build `ForgeHealth` themselves — so its existing
  `apiError` type just gains a `kind` field directly, the same way it
  already carries `rateLimit`; see design.md's Decisions for why one
  carrier per client is the better fit here, not a shared type
  everywhere.
- Replace the raw visible error text with a friendly, per-kind headline,
  and move the raw technical string into a collapsed `<details>`/
  `<summary>` disclosure — a native, keyboard-accessible widget needing no
  JS for the toggle itself, the same "prefer a native element" choice the
  forge segmented control already made.
- The `unreachable` case's copy mentions the force-refresh button (#225)
  as the way to retry immediately, not just "wait."
- **BREAKING**: none — `ForgeHealth.Error` stays present (now behind the
  disclosure); the new classification field is additive.

## Capabilities

### New Capabilities

- `forge-error-display`: classifies why a forge is unreachable into a
  small set of actionable categories, and presents a friendly reason with
  the raw technical detail available on demand rather than as the primary
  text.

### Modified Capabilities

None.

## Impact

- `internal/dashboard/model.go` — new `ForgeErrorKind` type/consts, new
  `ForgeHealth.ErrorKind` field, new `ClientError` type.
- `internal/forgejo/client.go` — `forgejoError` classifies via
  `resp.StatusCode` and wraps its result in `dashboard.ClientError`.
- `internal/github/client.go` — `restError` classifies via
  `ghsdk.ErrorResponse.Response.StatusCode`; the GraphQL path classifies
  via its own HTTP-status branch, and gets a new `Extensions.Type` field
  parsed on `graphqlErrorEntry` for the query-level-errors branch, which
  has no HTTP status to key off; `apiError` (or its call sites) wraps the
  result in `dashboard.ClientError` too.
- `internal/dashboard/generic_source.go` — unwraps `dashboard.ClientError`
  via `errors.As` when building `ForgeHealth` from a `ForgeClient` error.
- `api/openapi.yaml` — new `ForgeErrorKind` enum schema, new
  `ForgeHealth.errorKind` property; `bun run lint:api` must still pass.
- `internal/api/static/app.js` — `renderForgeHealth` builds a friendly
  headline from `errorKind` and a `<details>` disclosure for the raw
  `error` string, instead of the current `.forge-health-error` span and
  `chip.title`.
- `internal/api/static/style.css` — styling for the friendly headline and
  the disclosure, reusing the existing `--critical`/`--ink-2`/`--ink-3`
  token set rather than introducing new colors.
- Tests: `go test ./...` for the classification at each client's error
  site; `bunx playwright test` replacing/extending the one existing test
  that asserts the raw string is shown verbatim
  (`tests/dashboard.spec.js:67-100`).
