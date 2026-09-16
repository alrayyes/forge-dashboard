## Why

Nothing in this dashboard shows whether a pull request can actually be
merged. `internal/dashboard/model.go`'s `PullRequest` struct and
`api/openapi.yaml`'s `PullRequest` schema carry no mergeable/conflict field
and no auto-merge field today — a user has to open each PR on the forge
itself to find out it has a conflict, is blocked some other way, or already
has auto-merge scheduled. See
[#214](https://github.com/alrayyes/forge-dashboard/issues/214) for the
acceptance criteria this was built against.

## What Changes

- Add a mergeable/blocked-state field and an auto-merge field to the
  `PullRequest` model and API schema.
- **GitHub, via the existing GraphQL query** (`internal/github/client.go`'s
  `reposQueryTemplate`, this app's primary path): request `mergeable`,
  `mergeStateStatus`, and `autoMergeRequest` alongside the fields already
  fetched — zero additional HTTP requests, since the whole point of that
  query is fetching everything in one round trip. See
  [GitHub's GraphQL `PullRequest` reference](https://docs.github.com/en/graphql/reference/objects#pullrequest).
- **GitHub, REST fallback** (`listOpenPullRequestsREST`, the
  unauthenticated/username-only path): `AutoMerge` is already present on the
  existing List response, free. `Mergeable`/`MergeableState` aren't — per
  go-github's own doc comment, those need a per-PR `Get` call, the same cost
  shape the per-PR CI-status call on this path already pays.
- **Forgejo**: map the `Mergeable bool` field the SDK's `PullRequest` struct
  already carries, from the same `ListRepoPullRequests` call already made —
  currently fetched and silently discarded. No auto-merge read capability
  exists in the SDK at all (only write-side schedule/cancel verbs), so
  Forgejo PRs report auto-merge as "not reported by this forge," the same
  pattern already used for Forgejo's missing rate-limit reporting.
- A blocked/conflict pill next to the existing CI pill on a pull request
  row, shown only when the PR is actually blocked or conflicting — silent
  on a clean PR, matching how `.forge-health-error` only appears when
  there's a real problem.
- A separate auto-merge pill, shown only when auto-merge is genuinely
  enabled.
- **BREAKING**: none — additive fields and additive UI only.
- Explicitly **not** a merge button. This app states "read-only against
  both forges" in three places (README's Design section, the Settings
  page's own scope copy, `api/openapi.yaml`'s description), and nothing
  technically enforces that promise today — the classic GitHub token scope
  this app's own docs tell users to grant (`repo`) is full read-write, not
  an actually-read-only scope GitHub offers. Reversing that promise for
  every existing user's already-granted token, with no re-consent step, is
  a separate, deliberate decision this change does not make.

## Capabilities

### New Capabilities

- `pr-merge-status`: reports each pull request's mergeable/blocked state and
  auto-merge status, sourced from GitHub (GraphQL primary path, REST
  fallback) and Forgejo, with an explicit "not reported" state where a
  forge's API genuinely can't say.

### Modified Capabilities

None.

## Impact

- `internal/dashboard/model.go` — new fields on `PullRequest`.
- `api/openapi.yaml` — matching schema fields; `bun run lint:api` must still
  pass.
- `internal/github/client.go` — extend `reposQueryTemplate` and its mapping
  code (GraphQL path); add a per-PR mergeable fetch to the REST fallback
  path, map the already-free `AutoMerge` field there.
- `internal/forgejo/client.go` — map the already-fetched `Mergeable` field;
  no source of auto-merge state to map.
- No new capability interface needed: `ForgeClient.ListOpenPullRequests`
  already returns fully-populated `[]PullRequest` values directly — `CI` is
  set inline by each client's own mapping code, not through a separate
  optional interface the way `RateLimiter` is. The new mergeable/auto-merge
  fields follow that same existing convention, populated inline in
  `internal/github/client.go`'s `mapPullRequest`/`listOpenPullRequestsREST`
  and `internal/forgejo/client.go`'s PR mapping.
- `internal/api/static/app.js` — a new pill next to `ciPill`, and its wiring
  into `buildRow`.
- `internal/api/static/style.css` — styling for the new pill(s).
- Tests: `go test ./...` coverage for the new mapping in both clients;
  `bunx playwright test` coverage for the new pill(s).
