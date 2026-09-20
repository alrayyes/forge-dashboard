# Tasks

## 1. Invite storage

- [x] 1.1 Add the `invites` table to `Store.Init` (`internal/auth/store.go`): `token_hash TEXT PRIMARY KEY`, `username TEXT NOT NULL`, `display_name TEXT NOT NULL`, `created_by TEXT NOT NULL REFERENCES users(id)`, `expires_at TIMESTAMP NOT NULL`, `consumed_at TIMESTAMP`. Verify with a `go test ./internal/auth/...` run that exercises a fresh `Store.Init` against an in-memory SQLite DB.
- [x] 1.2 Add `Invite` to `internal/auth/model.go` (username, display name,
      expiry, consumed state) and verify it compiles with `go build ./...`.
- [x] 1.3 Implement `Store.CreateInvite(ctx, username, displayName, createdBy, ttl) (token string, invite *Invite, err error)` — generates a random token (same `crypto/rand` + hash pattern as `CreateAPIToken`), stores only the hash, returns the raw token once. Verify with a unit test asserting the returned token round-trips through `ConsumeInviteIfValid`.
- [x] 1.4 Implement `Store.ConsumeInviteIfValid(ctx, token, username) (*Invite, error)` — atomically checks the token hashes to an outstanding (unconsumed, unexpired) invite issued for that exact username, and marks it consumed in the same transaction. Verify with unit tests for: valid consume, expired token, already-consumed token, username mismatch, unknown token — each asserting the invite's `consumed_at` is unchanged on every rejection path.
- [x] 1.5 Implement `Store.ListOutstandingInvites(ctx) ([]*Invite, error)` (unconsumed and unexpired only) and `Store.RevokeInvite(ctx, token) error`. Verify with unit tests covering: an expired invite is excluded from the list, a revoked invite can no longer be consumed, revoking an unknown token is a no-op error.

## 2. Registration gating (service layer)

- [ ] 2.1 Change `Service.BeginRegistration` (`internal/auth/service.go`)
      to accept an invite token parameter. When `HasAnyRegisteredUser` is
      true, require `ConsumeInviteIfValid` to succeed before creating the
      user, using the invite's own `displayName` rather than any
      caller-supplied value; when false, keep today's no-invite bootstrap
      path unchanged. Return a new `ErrInvalidInvite` sentinel on failure.
      Verify by updating `internal/auth/service_test.go`:
      `TestBeginRegistration_FirstUser_BecomesAdmin` and
      `TestBeginRegistration_AbandonedRegistration_CanBeReclaimed` keep
      passing with no invite argument; add
      `TestBeginRegistration_SecondUser_WithoutInvite_IsRejected`,
      `TestBeginRegistration_SecondUser_WithValidInvite_Succeeds`,
      `TestBeginRegistration_WithExpiredInvite_IsRejected`,
      `TestBeginRegistration_WithConsumedInvite_IsRejected`,
      `TestBeginRegistration_WithInviteForDifferentUsername_IsRejected`.
- [ ] 2.2 Add `Service.CreateInvite(ctx, requester *User, username, displayName) (token string, invite *Invite, error)` that rejects a non-admin requester and an already-registered username. Verify with unit tests for both rejection paths and the success path.
- [ ] 2.3 Add `Service.HasAnyRegisteredUser(ctx) (bool, error)` as an
      exported wrapper if not already reachable outside the package (it's
      currently a `Store` method used internally), for the new public
      registration-status endpoint. Verify it compiles and is covered by
      an existing or new unit test.

## 3. API: registration and status endpoints

- [ ] 3.1 Update `handleRegisterBegin`/`handleRegisterFinish`
      (`internal/api/auth.go`) to accept and thread through an
      `inviteToken` field on the request body, returning 403 with a clear
      error body on `ErrInvalidInvite`. Verify with
      `internal/api/auth_test.go` cases: begin without invite after
      bootstrap → 403; begin with valid invite → 200; begin with
      expired/consumed/mismatched invite → 403.
- [ ] 3.2 Add `GET /api/auth/registration-status` (unauthenticated) returning `{"open": bool}` — true only when zero users are registered — wired in `internal/api/server.go`. Verify with a test asserting `open: true` on an empty store and `open: false` after one user registers.
- [ ] 3.3 Update `api/openapi.yaml`: add `inviteToken` to the register
      request schema, document the new 403 response, add the
      `registration-status` path. Verify with `bun run lint:api`.

## 4. API: admin invite management

- [ ] 4.1 Add `AdminInvite` response type and `handleAdminCreateInvite`,
      `handleAdminListInvites`, `handleAdminRevokeInvite` to
      `internal/api/admin.go`, following the existing
      list/revoke/delete-user handler shape (`writeJSON`, `errorBody`).
- [ ] 4.2 Wire `POST /api/admin/invites`, `GET /api/admin/invites`,
      `POST /api/admin/invites/{token}/revoke` in `internal/api/server.go`,
      behind the same `auth.RequireAuth(store)(auth.RequireAdmin(...))`
      composition the existing admin routes use.
      Verify with `internal/api/admin_test.go` cases: non-admin gets 403
      on all three; admin can create, list (sees it outstanding), and
      revoke (it disappears from the list and can no longer register).
- [ ] 4.3 Update `api/openapi.yaml` with the three new
      `/api/admin/invites*` paths and their schemas, tagged `admin`.
      Verify with `bun run lint:api`.

## 5. Frontend: login page

- [ ] 5.1 In `web/src/routes/login/+page.svelte`, fetch
      `/api/auth/registration-status` on load; only render the "Register a
      new passkey instead" button (and the generic register form) when
      `open` is true.
- [ ] 5.2 Read an `invite` query parameter; when present, skip
      `registration-status` entirely, show a registration form with no
      username/display-name inputs (both come from the invite), and pass
      the token through to `/api/auth/register/begin`/`/finish`. Show a
      clear error state for an invalid/expired/consumed invite (surfaced
      from the 403 body).
- [ ] 5.3 Verify with Playwright: extend `tests/auth.spec.js` (or add a
      case) covering: the register button is absent once a user exists and
      no invite is present; visiting `/login?invite=<token>` from a
      freshly created invite shows the invite-scoped form and completes
      registration; an expired/consumed invite link shows an error and
      does not register. Run `bun run test:e2e`.

## 6. Frontend: admin invite management UI

- [ ] 6.1 Add an "Invites" section to
      `web/src/routes/(app)/admin/+page.svelte`: a form (username, display
      name) to create an invite, showing the generated link once with a
      copy button; a table of outstanding invites (username, expiry) with
      a **Revoke** action, mirroring the existing user table's pattern.
- [ ] 6.2 Verify with Playwright: extend `tests/admin.spec.js` covering
      generating an invite (link appears), listing it as outstanding, and
      revoking it (disappears from the list). Include the axe-core scan
      already required for pages this journey test covers (`rules/a11y.md`)
      — assert zero violations on the new admin invite UI. Run
      `bun run test:e2e`.

## 7. Documentation

- [ ] 7.1 Rewrite README's **Authentication** and **Admin area** sections
      to describe the invite-gated model: first registration still
      bootstraps the admin, every registration after that requires an
      admin-issued invite link, and the network-perimeter language is
      removed since it's no longer the operative control. Verify by
      re-reading the full README top to bottom for consistency with the
      rest of the document.

## 8. Full verification pass

- [ ] 8.1 Run `go test ./...`, `bun run test:e2e`, `bun run check:web`,
      `bun run lint:js`, and `bun run lint:api`, all green.
