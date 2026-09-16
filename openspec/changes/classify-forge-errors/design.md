## Context

See proposal.md - Why/What Changes for the motivation. Current shape,
confirmed by reading the code directly:

- `internal/dashboard/model.go:18-45` — `CIStatus` and `MergeStatus` are
  both a coarse `type X string` + const block, the pattern to mirror.
  `model.go:88-97` — `RateLimit`'s nilable-pointer doc comment is the
  "this forge doesn't report it" idiom already established.
- `internal/github/client.go:125-132` — `apiError{msg, rateLimit}` already
  carries structured data alongside a message string, unwrapped via
  `errors.As` at `fetchViaGraphQL` (`client.go:502-508`) to populate
  `ForgeHealth.RateLimit` even from a failed request.
- `internal/github/client.go:444-489` (`graphqlDo`) has **three** distinct
  failure shapes, not two:
  1. `c.httpClient.Do(req)` itself fails (`client.go:458-460`) — a true
     transport-level failure (DNS, connection refused, timeout). Returns
     the **bare, unwrapped** Go error today — no `"github: POST /graphql:"`
     prefix, no `apiError` wrapping at all. This is the genuine
     "unreachable" case, and it's currently the one path that skips this
     file's own error-formatting convention entirely.
  2. Non-2xx HTTP status (`client.go:461-464`) — `resp.StatusCode` is
     directly available.
  3. HTTP 200 with a populated GraphQL `errors` array
     (`client.go:477-488`) — no HTTP status to key off; `rateLimitShortMessage`
     already checks the response headers here (GitHub sometimes reports
     rate limiting this way instead of a non-2xx status), but nothing
     else about this branch is classified.
- `internal/github/client.go:692-706` (`restError`) — the REST-fallback
  path's own three shapes: `*ghsdk.RateLimitError`/`*ghsdk.AbuseRateLimitError`
  (both embed enough to detect rate limiting without a status code),
  `*ghsdk.ErrorResponse` (embeds `Response *http.Response`, so
  `errResp.Response.StatusCode` is reachable), and a bare catch-all
  (`client.go:705`) — the same "never wrapped in `apiError`, no status
  code available" transport-failure shape as `graphqlDo`'s first case.
  `restError` returns a plain `fmt.Errorf`-wrapped error today, never an
  `*apiError` — `fetchPublicViaREST` (`client.go:708-713`) has no
  `errors.As` extraction at all, unlike `fetchViaGraphQL`.
- `internal/forgejo/client.go:69-85` (`forgejoError`) — `resp` is the
  `*gitea.Response` the SDK call returned; per its own doc comment,
  "populated even on a failed request" — i.e. any real HTTP response,
  4xx/5xx included. A `nil` `resp` is what's left: a transport-level
  failure, the same "unreachable" shape as the other two clients' own
  bare catch-alls.
- `internal/dashboard/generic_source.go:63-70` (`GenericSource.Fetch`)
  calls `s.client.ListRepos(ctx)` through the `ForgeClient` interface —
  today Forgejo is the only implementation that actually goes through
  this generic path (GitHub implements its own `Source` directly, for
  the single-GraphQL-query efficiency `GenericSource`'s
  one-repo-at-a-time model doesn't support). This file cannot reference
  an unexported type from `internal/forgejo` — Go's own visibility rules
  block it regardless of `errors.As` — so a classification carrier for
  this path has to be an exported type living in `internal/dashboard`
  itself.

## Goals / Non-Goals

**Goals:**

- Classify every one of the three clients' error-construction sites into
  a small, coarse `ForgeErrorKind`, using signals (status code, SDK error
  type, rate-limit headers) already reachable at each site today.
- Keep each client's own existing error-wrapping idiom rather than
  forcing one shared carrier type everywhere — `apiError` (GitHub-only,
  already exists) gains a `kind` field the same way it already has
  `rateLimit`; only the `GenericSource`-driven path (Forgejo today, any
  future simple `ForgeClient` tomorrow) needs a new shared type, since
  that's the one place classification has to cross a package boundary
  `internal/dashboard` can't see through.
- Fix, in passing, `graphqlDo`'s and `restError`'s bare transport-failure
  fallbacks so they carry the same `"github: ..."` prefix and structure
  every other error from this file already has — not scope creep, since
  attaching `ForgeErrorUnreachable` means touching these exact lines
  anyway.

**Non-Goals:**

- Not a fine-grained classification matching every status code GitHub or
  Forgejo can return — same "stay coarse" reasoning `MergeStatus`'s own
  doc comment already gives for this codebase.
- Not retrying or changing behavior based on the classification — this is
  display-only; the existing scheduled refresh and the force-refresh
  button (#225) are unaffected.

## Decisions

**`ForgeErrorKind` is a new `dashboard` type, `unreachable`/
`unauthorized`/`not_found`/`rate_limited`/`unknown`**, mirroring
`CIStatus`/`MergeStatus`'s exact shape (`type X string` + const block with
a comment justifying the coarseness). Empty string (Go's zero value) is
the implicit "no error to classify" case — `ForgeHealth.ErrorKind` is
`omitempty` in JSON, only ever populated alongside a non-empty `Error`.

**A new `dashboard.ClientError{Kind, Err}` type, exported, implementing
`error` and `Unwrap() error`, for `GenericSource`-driven clients only.**
Forgejo's `forgejoError` wraps its final message in this instead of
returning a bare `fmt.Errorf`; `GenericSource.Fetch` (`generic_source.go:67`)
does an `errors.As` against it, the same "structured data alongside a
message string" shape `apiError.rateLimit` already established, just
promoted to `internal/dashboard` since this is the one call site that
genuinely needs to read classification from an opaque, forge-agnostic
`error`. This is deliberately **not** used by GitHub's own `fetchViaGraphQL`/
`fetchPublicViaREST` — see the next decision.

**GitHub keeps using its own `apiError`, extended with a `kind` field,
rather than also adopting `dashboard.ClientError`.** GitHub never goes
through `GenericSource` — both its `Source` methods build `ForgeHealth`
themselves and already do `errors.As(err, &apiErr)` for `rateLimit`
(`client.go:504-508`); adding `kind` alongside it there is a one-line
change, not a new pattern. Two carrier types for one concept reads
inconsistent at a glance, but it matches what's already true of
`rateLimit` today — Forgejo has no rate-limiting of its own to carry in
the first place, so the two clients were never symmetric here to begin
with. Forcing them onto one shared type would mean either exporting
`apiError` (turning a GitHub-internal detail into public API) or moving
GitHub's own rate-limit sidecar into `dashboard.ClientError` too, a
bigger and unrelated change this proposal doesn't need to make.

**Classification logic per site:**

- `forgejoError`: `resp == nil` → `Unreachable`; else switch
  `resp.StatusCode`: `401`/`403` → `Unauthorized`, `404` → `NotFound`,
  `429` → `RateLimited`, default → `Unknown`.
- `graphqlDo`'s transport-failure branch (`client.go:458-460`, currently
  a bare `return err`): wrapped as `&apiError{msg: "github: POST /graphql: " +
err.Error(), kind: dashboard.ForgeErrorUnreachable}` — this is the fix
  described in Goals above.
- `graphqlDo`'s non-2xx branch: switch `resp.StatusCode` the same as
  Forgejo's, `429` folded in as a backup since `rateLimitShortMessage`'s
  own header check already fires first whenever GitHub's response
  actually says so.
- `graphqlDo`'s 200-with-`errors`-array branch: `rateLimitShortMessage`'s
  existing header check takes priority (unchanged); otherwise a new
  `Extensions.Type` field parsed onto `graphqlErrorEntry` (GitHub's
  GraphQL errors carry one) drives `FORBIDDEN`/`UNAUTHENTICATED`/
  `INSUFFICIENT_SCOPES` → `Unauthorized`, `NOT_FOUND` → `NotFound`,
  `RATE_LIMITED` → `RateLimited`, anything else/absent → `Unknown`.
- `restError`: `*ghsdk.RateLimitError`/`*ghsdk.AbuseRateLimitError` →
  `RateLimited`; `*ghsdk.ErrorResponse` → switch
  `errResp.Response.StatusCode` the same as the other two; the bare
  catch-all (`client.go:705`) → `Unreachable`. Returns `*apiError{msg,
kind}` now instead of a plain `fmt.Errorf`, so `fetchPublicViaREST`
  gains the same `errors.As(err, &apiErr)` extraction `fetchViaGraphQL`
  already has.

**Frontend: friendly headline + `<details>` disclosure, not a rewritten
chip.** The existing chip (`.forge-health`/`.forge-health.unreachable`,
`style.css:229-244`) and its label ("GitHub unreachable") stay as-is —
that part already reads fine. What changes is what renders below it:
today's raw `.forge-health-error` span becomes a `HEADLINE[kind]` lookup
table's text, and the raw `f.error` string moves inside a collapsed
`<details><summary>Show details</summary>...</details>` rather than being
shown outright or as `chip.title`. `chip.title` is dropped entirely — the
existing code comment already argued a tooltip alone isn't good enough
(unreachable on touch, unreliable for a screen reader), and now there's a
real, keyboard-reachable disclosure making the tooltip redundant on top
of insufficient.

**Headline copy per kind:**

- `unreachable`: "Temporarily unreachable — try the refresh button above,
  or it'll retry automatically."
- `unauthorized`: "Check the token in Settings."
- `not_found`: "Check the instance URL in Settings."
- `rate_limited`: "Rate limit exceeded." (the existing `rateLimitChip`
  already shows the budget/reset time alongside this when the forge
  reports one — no duplication needed here.)
- `unknown` / empty: "Something went wrong talking to {forge label}."

## Risks / Trade-offs

- Status-code-based classification can misfire on a forge instance with
  unusual proxy/gateway behavior (a 404 from a misconfigured reverse
  proxy rather than a genuine wrong-URL problem) → Mitigation: the raw
  detail is still one click away in the disclosure; this was already true
  of the raw string before, just now there's a (usually correct) friendly
  guess in front of it rather than nothing.
- GitHub's GraphQL `Extensions.Type` values aren't formally versioned
  API — a future GitHub change could rename or drop one → Mitigation: an
  unrecognized value already falls back to `Unknown`, which degrades to
  the generic headline, never a wrong specific one.
- Two classification carrier types (`apiError.kind` for GitHub,
  `dashboard.ClientError` for `GenericSource`-driven clients) instead of
  one → Mitigation: covered above under Decisions; matches the existing,
  already-asymmetric `rateLimit` precedent rather than inventing new
  asymmetry.

## Migration Plan

Additive field on `ForgeHealth` and the OpenAPI schema, ships as a normal
PR. No data migration. Rollback is a normal revert.

## Open Questions

None.
