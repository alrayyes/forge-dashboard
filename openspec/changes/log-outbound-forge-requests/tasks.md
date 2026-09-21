# Tasks

## 1. Storage

- [x] 1.1 Add the `request_log` table to `Store.Init` (`internal/auth/store.go`):
      `id INTEGER PRIMARY KEY AUTOINCREMENT`, `logged_at TIMESTAMP NOT NULL`,
      `forge TEXT NOT NULL`, `account_id TEXT REFERENCES users(id)`,
      `method TEXT NOT NULL`, `endpoint TEXT NOT NULL`,
      `status_code INTEGER`, `outcome TEXT NOT NULL`,
      `rate_limit_limit INTEGER`, `rate_limit_remaining INTEGER`,
      `rate_limit_resets_at TIMESTAMP`, `rate_limit_cost INTEGER`.
      Verify with a `go test ./internal/auth/...` run that exercises a
      fresh `Store.Init` against an in-memory SQLite DB.
- [x] 1.2 Create `internal/requestlog` package with an `Entry` struct
      mirroring the table's columns and verify it compiles with
      `go build ./...`.
- [x] 1.3 Implement `Store.RecordRequest(ctx, Entry) error` on
      `internal/auth.Store` — inserts a row, then deletes the oldest rows
      past a fixed retention cap (`internal/requestlog.MaxEntries`, e.g.
      10,000) in the same transaction. Verify with a unit test asserting
      that inserting `MaxEntries+50` rows leaves exactly `MaxEntries`,
      the oldest ones gone.
- [x] 1.4 Implement `Store.ListRequests(ctx, filter) ([]Entry, error)` —
      filter by optional `forge` and `account_id`, newest first. Verify
      with unit tests: no filter returns everything, a forge filter and
      an account filter each narrow correctly, and an empty result set
      returns an empty slice, not an error.

## 2. Recording interface

- [x] 2.1 Define `internal/requestlog.Recorder` interface (one method,
      e.g. `Record(ctx context.Context, e Entry) error`) and a concrete
      `internal/requestlog.SQLiteRecorder` wrapping
      `Store.RecordRequest`. Verify it compiles and
      `SQLiteRecorder` satisfies `Recorder` (a compile-time assertion,
      `var _ Recorder = (*SQLiteRecorder)(nil)`).
- [x] 2.2 Thread a `Recorder` into `github.NewClient` and
      `forgejo.NewClient` (accept it as a constructor parameter,
      defaulting to a no-op `Recorder` implementation when nil, so every
      existing caller and test keeps compiling unchanged). Verify with
      `go build ./...` and the existing `internal/github`/`internal/forgejo`
      test suites still passing unmodified.
- [x] 2.3 Call `Recorder.Record` from `internal/github/client.go`'s
      `graphqlDo` and every REST call site (`UpdateBranch`,
      `CommentPullRequest`, `AddLabel`, `checkWebhooks`, the REST
      fallback fetch), on both the success and failure paths, populating
      `Entry` from what each call site already has (method, endpoint,
      status, `apiError`/`ClientError` kind, rate-limit fields). A
      `Record` error is logged via `slog.Warn` and otherwise ignored —
      it never changes the call's own return value. Verify with new
      `internal/github` tests using a fake `Recorder` that captures
      calls: a successful GraphQL fetch records one entry with the
      GraphQL rate-limit fields; a rate-limited failure records one
      entry with `outcome: "rate_limited"`; a `Recorder` that returns an
      error doesn't change `Fetch`'s own result.
- [x] 2.4 Do the equivalent for `internal/forgejo/client.go`'s request
      path(s). Verify with the same shape of fake-`Recorder` tests as
      2.3, adapted to Forgejo's own call sites (no GraphQL, no
      rate-limit fields to populate beyond status/outcome).
- [x] 2.5 Wire the account ID through: each account's `Aggregator`
      (`internal/dashboard/manager.go`) constructs its own forge clients
      already — pass that account's user ID into `NewClient` so every
      `Entry` it records carries the right `account_id`. Verify with a
      `internal/dashboard` test asserting two different users' recorded
      entries carry two different account IDs.

## 3. API

- [x] 3.1 Update `api/openapi.yaml`: add `GET /api/admin/requests`
      (query params `forge`, `account`; returns a list of request-log
      entries) and `GET /api/admin/requests/export` (same query params,
      `text/csv` response), both tagged `admin`. Verify with
      `bun run lint:api`.
- [x] 3.2 Implement `handleAdminListRequests` and
      `handleAdminExportRequests` in `internal/api/admin.go`, wired in
      `internal/api/server.go` behind the existing
      `auth.RequireAuth(store)(auth.RequireAdmin(...))` composition.
      `handleAdminExportRequests` writes `Content-Type: text/csv` and a
      `Content-Disposition: attachment` header, one row per entry with a
      header row naming each column. Verify with
      `internal/api/admin_test.go` cases: non-admin gets 403 on both; a
      forge/account filter narrows the list endpoint's results; the CSV
      export's body round-trips through `encoding/csv`'s reader back
      into the same rows the list endpoint returned for the same filter.

## 4. Frontend

- [ ] 4.1 Add a "Requests" section to
      `web/src/routes/(app)/admin/+page.svelte`, following the existing
      Users/Invites table pattern: forge and account filter controls, a
      table of entries (timestamp, forge, account, method/endpoint,
      status, outcome, rate-limit remaining), and an "Export CSV" control
      that navigates to `/api/admin/requests/export` with the current
      filters as query params.
- [ ] 4.2 Verify with Playwright: extend `tests/admin.spec.js` covering
      the Requests section rendering recorded entries, a filter narrowing
      the visible rows, and the export control's `href`/click reaching
      the export endpoint. Include the axe-core scan already required
      for pages this journey test covers (`rules/a11y.md`) — assert zero
      violations on the new Requests section. Run `bun run test:e2e`.

## 5. Documentation

- [ ] 5.1 Add a section to the README's **Admin area** describing the
      request log: what it records, that it's admin-only and
      cross-account, and the CSV export. Verify by re-reading the full
      README top to bottom for consistency with the rest of the
      document.

## 6. Full verification pass

- [ ] 6.1 Run `go test ./...`, `bun run test:e2e`, `bun run check:web`,
      `bun run lint:js`, and `bun run lint:api`, all green.
