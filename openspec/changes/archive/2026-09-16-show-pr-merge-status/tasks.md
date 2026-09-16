## 1. Model and API schema

- [x] 1.1 Add `type MergeStatus string` with `MergeMergeable`/`MergeConflicting`/`MergeBlocked`/`MergeUnknown` constants to `internal/dashboard/model.go`, mirroring `CIStatus`'s exact shape (`model.go:18-27`), and add `MergeStatus MergeStatus` and `AutoMergeEnabled *bool` fields to `PullRequest` (`model.go:38-50`); verify `go build ./...` and `go vet ./...` pass.
- [x] 1.2 Add matching `MergeStatus` and `autoMergeEnabled` (nullable boolean) fields to `api/openapi.yaml`'s `PullRequest` schema, plus a new `MergeStatus` enum schema mirroring `CIStatus`'s (`api/openapi.yaml:856-859`); verify `bun run lint:api` passes.

## 2. GitHub GraphQL mapping (primary path)

- [x] 2.1 Add `mergeStateStatus` and `autoMergeRequest{mergeMethod}` to the pull request fields in `reposQueryTemplate` (`internal/github/client.go:326-397`) and the matching fields on `graphqlPullRequest` (`client.go:244-258`) — `mergeable` itself turned out unnecessary: `mergeStateStatus: DIRTY` already implies it, per design.md's Decisions.
- [x] 2.2 Map `mergeStateStatus` into `dashboard.MergeStatus` per design.md's Decisions (CLEAN→Mergeable, DIRTY→Conflicting, BLOCKED/BEHIND/UNSTABLE/HAS_HOOKS→Blocked, DRAFT/UNKNOWN→Unknown) and `autoMergeRequest` presence into `AutoMergeEnabled` (non-nil `&true` when present, `&false` when absent — GitHub always answers this one) in `mapPullRequest` (`client.go:514-527`); verify with a unit test covering each `mergeStateStatus` value's mapping.
- [x] 2.3 Verify manually (or via an existing/new `go test` case against a captured fixture response) that the added query fields don't change the query's existing pagination/rate-limit behavior.

## 3. GitHub REST fallback mapping (unauthenticated/username-only path)

- [x] 3.1 Map the already-free `AutoMerge` field (`p.GetAutoMerge()`) into `AutoMergeEnabled` in `listOpenPullRequestsREST` (`client.go:730-766`); verify with a unit test.
- [x] 3.2 Decide and implement the mergeable-state source for this path per design.md's Open Question — either a per-PR `Get` call (same shape as the existing `ciStatusREST` call on this path) mapped to `MergeStatus`, or `MergeUnknown` left as a deliberate fast-follow if deferred; document whichever is chosen in a code comment referencing this decision, and verify with a unit test.

## 4. Forgejo mapping

- [x] 4.1 Map the SDK's already-fetched `Mergeable bool` field (on the same `ListRepoPullRequests` response `internal/forgejo/client.go:184-232` already reads) into `MergeStatus` per design.md's Decisions (`true`→Mergeable, `false`→Blocked, never Conflicting); leave `AutoMergeEnabled` as `nil` with a comment citing the SDK's lack of a read capability; verify with a unit test.

## 5. Frontend: blocked/conflict and auto-merge pills

- [x] 5.1 Add a `mergeStatusPill(status)` function in `internal/api/static/app.js` alongside `ciPill`, rendered only for `MergeConflicting`/`MergeBlocked` (silent for `MergeMergeable`/`MergeUnknown`) and wired into `buildRow`.
- [x] 5.2 Add an `autoMergePill()` function, rendered only when `autoMergeEnabled === true` (silent when `false` or `null`), wired into `buildRow` alongside the merge-status pill.
- [x] 5.3 Style both pills in `internal/api/static/style.css`, following the existing `.ci-pill`/`.forge-health` chip visual language (colored dot + label, per-state color).
- [x] 5.4 Verify manually that a clean, non-auto-merge PR row shows neither pill, keeping the common case visually unchanged from before this change.

## 6. Tests

- [x] 6.1 `go test ./...` covering: each `mergeStateStatus`/`Mergeable` mapping branch (GitHub GraphQL, GitHub REST, Forgejo) and the `AutoMergeEnabled` nil-vs-set cases.
- [x] 6.2 `bunx playwright test` coverage in `tests/dashboard.spec.js`: a PR row with `mergeStatus: "conflicting"` shows the blocked/conflict pill; a PR row with `mergeStatus: "mergeable"` and no `autoMergeEnabled` shows neither pill; a PR row with `autoMergeEnabled: true` shows the auto-merge pill; an axe-core accessibility check with both pills rendered.
- [x] 6.3 Run the full suite (`bunx playwright test`, `bun run lint:js`, `go test ./...`, `bun run lint:api`) across all touched files and fix any regression before considering the change done.
