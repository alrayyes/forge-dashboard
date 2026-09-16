## Context

See proposal.md - Why/What Changes for the motivation and the research
citations. Current shape, confirmed by reading the code directly:

- `internal/dashboard/model.go:38-50` — `PullRequest` has a `CI CIStatus`
  field (a `type CIStatus string` with `CISuccess`/`CIFailure`/`CIPending`/
  `CINone` constants, `model.go:18-27`), populated **inline** by each
  client's own PR-mapping code — not through a separate optional-capability
  interface the way `RateLimit` is.
- `internal/github/client.go:326-397` (`reposQueryTemplate`) — the single
  GraphQL query this app's primary path runs once per refresh; PR fields
  requested today: `number, title, url, isDraft, author, labels, createdAt,
updatedAt, commits(last:1){...statusCheckRollup}`. Mapped by
  `mapPullRequest` (`client.go:514-527`).
- `internal/github/client.go:730-766` (`listOpenPullRequestsREST`) — the
  REST fallback for the unauthenticated/username-only mode, mapping
  directly from the SDK's `*github.PullRequest` (`p.GetNumber()`,
  `p.GetTitle()`, etc.) plus a per-PR `ciStatusREST` call already paid on
  this path.
- `internal/forgejo/client.go:184-232` (`ListOpenPullRequests`) — one
  `ListRepoPullRequests` call per repo, mapping into `dashboard.PullRequest`
  directly; the SDK's `*gitea.PullRequest.Mergeable bool` field is present
  on that same response today and simply isn't read.
- `ForgeHealth.RateLimit *RateLimit` (`model.go`) is the existing precedent
  for "this forge might not report this value at all" — a nilable pointer,
  checked and rendered as "Not reported by this forge" in both `app.js`'s
  `renderForgeHealth` and `insights.js`'s `renderRateLimits`.

## Goals / Non-Goals

**Goals:**

- Surface blocked/conflicting state and auto-merge state per pull request,
  at no added request cost on GitHub's GraphQL path (this app's default).
- Handle Forgejo's real capability gaps (a possibly-stale `Mergeable` flag,
  no auto-merge read capability at all) honestly rather than guessing.
- Keep the existing per-client inline-mapping convention `CI` already
  established — no new abstraction layer for what's still just more fields
  on the same struct.

**Non-Goals:**

- Not a merge button, not any write capability against either forge — see
  proposal.md's explicit call-out.
- Not adding the per-PR `Get` call for GitHub REST-fallback mergeable state
  in this change's first cut if it complicates the plan — see Open
  Questions.
- Not building a `MergeStatusReporter`-style optional interface — ruled out
  once the actual code showed `CI` (the closest existing analog) is set
  inline per-client, not through a capability check.

## Decisions

**New `MergeStatus` enum, mirroring `CIStatus`'s exact shape.**
`type MergeStatus string` with `MergeMergeable`, `MergeConflicting`,
`MergeBlocked`, `MergeUnknown` constants, plus a new `MergeStatus
MergeStatus` field on `PullRequest` (always populated, `MergeUnknown` the
zero-value fallback) — same pattern `CIStatus`/`CINone` already uses, not a
pointer. Considered a plain `bool` (`Mergeable`) matching Forgejo's own SDK
field name — rejected because GitHub's GraphQL `mergeStateStatus` carries
real distinctions (a stale branch vs. an actual conflict vs. blocked by a
required check) worth keeping rather than collapsing to true/false, and the
UI only needs a coarse bucket, not GitHub's full eight-value enum, so a
small dashboard-owned enum is the right altitude.

**GitHub GraphQL mapping**: add `mergeable` and `mergeStateStatus` to
`reposQueryTemplate`, map into `MergeStatus` as: `mergeStateStatus: CLEAN`
→ `MergeMergeable`; `DIRTY` → `MergeConflicting`; `BLOCKED`/`BEHIND`/
`UNSTABLE`/`HAS_HOOKS` → `MergeBlocked`; `DRAFT`/`UNKNOWN` → `MergeUnknown`.
(`mergeable: CONFLICTING` is already implied by `mergeStateStatus: DIRTY`
in practice, so `mergeStateStatus` alone drives the mapping — no need to
also branch on `mergeable`.)

**Forgejo mapping is deliberately coarser than its own field name
suggests.** `Mergeable: true` → `MergeMergeable`; `Mergeable: false` →
`MergeBlocked`, **not** `MergeConflicting` — per the upstream Gitea issues
cited in the proposal, a `false` here can mean a real conflict, a check
still running, or a stale background-queue computation, and this system
has no way to tell those apart from this one field. `MergeBlocked` says
"something's stopping this" without asserting a cause the data doesn't
actually support; `MergeConflicting` would overclaim.

**`AutoMergeEnabled *bool`, not a plain `bool`.** Nilable, following
`RateLimit`'s existing precedent for "this forge might not report this at
all": `nil` = not reported by this forge (always the case for Forgejo,
today), `&true`/`&false` = GitHub's actual state. A plain `bool` would
force Forgejo PRs to render as "auto-merge not enabled," a false negative
the data doesn't support — the same class of mistake `RateLimit` being
nilable already avoids for rate-limit reporting.

**GitHub REST-fallback mergeable state stays `MergeUnknown`, deferred
rather than paying a per-PR `Get` call.** Resolved during implementation
(see the Open Question below): this path is already the
unauthenticated/username-only mode, IP-limited to 60 requests/hour and
already spending one request per PR on CI status — adding a second per-PR
call for `Mergeable`/`MergeableState` would materially eat into that
already-tight budget for a mode most accounts don't use. `AutoMerge` costs
nothing extra there regardless — it's already on the List response
(`p.GetAutoMerge()`) — only `Mergeable`/`MergeableState` needed the extra
call this ended up not making.

## Risks / Trade-offs

- GitHub REST-fallback mode (no token, username-only) pays one more
  request per pull request for mergeable state, on top of the CI-status
  call it already makes → Mitigation: this path is already the
  degraded/unauthenticated mode with lower request budgets expected; the
  added cost is the same shape as an already-accepted cost on the same
  path, not a new category of problem.
- Forgejo's `Mergeable` can be stale per the cited upstream issues, so a
  `MergeBlocked` shown for a Forgejo PR might already be resolved by the
  time it's seen → Mitigation: mapping to the coarser `MergeBlocked`
  rather than `MergeConflicting` already hedges this; no further staleness
  handling (a "recompute" trigger, a warning icon) is in scope here.
- Adding fields to `reposQueryTemplate` increases that query's per-request
  GraphQL node cost → Mitigation: `mergeable`/`mergeStateStatus`/
  `autoMergeRequest` are scalar/shallow fields on an already-fetched node,
  not a new nested connection — negligible compared to the `labels`/
  `commits` connections already in the query.

## Migration Plan

Additive fields on `PullRequest` and the OpenAPI schema, ships as a normal
PR. No data migration — the fields are always computed fresh from each
refresh, nothing persisted needs backfilling. Rollback is a normal revert.

## Open Questions

None remaining — the one open question at proposal time (whether the
GitHub REST-fallback path pays a per-PR mergeable `Get` call now or as a
fast-follow) was resolved during implementation: deferred, per the
Decisions section above.
