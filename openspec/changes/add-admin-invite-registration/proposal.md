# Proposal

## Why

Self-registration is open forever: `Service.BeginRegistration`
(`internal/auth/service.go:54`) makes the first completed registration an
admin, but nothing closes registration after that, and the login page's
"Register a new passkey instead" button (`web/src/routes/login/+page.svelte:306`)
is shown unconditionally. Any anonymous visitor to `/login` can create their
own (non-admin) account at any time.

Today's README documents this as intentional: the deployment's network
boundary (Tailscale-only) is called out as the thing that actually stops a
stranger from registering, not application code. This change deliberately
replaces that network-perimeter trust model with an admin-approval one —
new accounts should only exist because the admin decided to add one,
regardless of who else can reach the instance.

## What Changes

- **BREAKING**: `POST /api/auth/register/begin` and `/finish` no longer
  accept open self-registration once any user has completed registration.
  The very first registration still bootstraps that user as admin, exactly
  as today; every registration after that must present a valid invite
  token.
- The login page's "Register a new passkey instead" button is only shown
  when the instance has zero registered users (bootstrap case). It's
  replaced everywhere else by an invite-link landing flow: visiting
  `/login?invite=<token>` (or equivalent) shows the registration form
  pre-scoped to that invite instead of the generic self-serve button.
- New admin-only capability to generate a passkey-registration invite: a
  single-use, time-limited, cryptographically random token the admin hands
  to the new person out of band (copy-paste link; no email system exists
  today). The admin picks the username and display name up front; the
  invitee only completes the WebAuthn ceremony.
- New admin-only capability to list and revoke outstanding (unconsumed)
  invites.
- An invite is consumed atomically with the registration it authorizes: a
  token can register exactly one account, and expires after a fixed TTL if
  never used.

## Capabilities

### New Capabilities

- `admin-invite-registration`: how new accounts get created after the
  first (bootstrap) admin — the first-user-becomes-admin rule, the
  server-side close of open self-registration, admin-issued single-use
  invite tokens, and invite-scoped passkey registration.

### Modified Capabilities

(none — no existing spec documents today's registration behavior)

## Impact

- `internal/auth/service.go`: `BeginRegistration` gains an invite-token
  parameter and must reject registration when no invite is presented and a
  user already exists.
- `internal/auth/store.go`: new `invites` table (token hash, username,
  display name, expiry, consumed state) and accompanying queries; schema
  migration via the existing hand-written `addColumnsIfMissing`-style
  init path.
- `internal/auth/model.go`: new `Invite` type.
- `internal/api/auth.go`, `internal/api/server.go`: `register/begin` and
  `register/finish` request/response shapes change to carry the invite
  token; new admin-only routes to create/list/revoke invites.
- `internal/api/admin.go`: new handlers for invite management, alongside
  the existing user list/revoke/delete handlers.
- `web/src/routes/login/+page.svelte`: conditional rendering of the
  self-serve register button (bootstrap-only) vs. an invite-token
  registration path.
- `web/src/routes/(app)/admin/+page.svelte`: new UI to generate, list, and
  revoke invites.
- `api/openapi.yaml`: updated `/api/auth/register/*` schemas, new
  `/api/admin/invites*` paths.
- `README.md`: **Authentication** and **Admin area** sections currently
  document "whoever registers first becomes admin" plus the network-
  perimeter trust model as the whole story; both need rewriting for the
  invite-gated model.
