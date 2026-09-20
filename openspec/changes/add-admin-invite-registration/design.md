# Design

## Context

See proposal.md - Why. Today `Service.BeginRegistration`
(`internal/auth/service.go:54-98`) is the only gate: it checks
`HasAnyRegisteredUser` purely to decide the _first_ account's `IsAdmin`
flag, never to refuse a second, third, or Nth self-registration. The login
page (`web/src/routes/login/+page.svelte`) has no server-driven signal for
whether registration should even be offered — `showRegister` just flips
local UI state.

The codebase already has one precedent for a random, hashed, single-use
secret: `api_tokens` (`internal/auth/store.go:67-75`, `CreateAPIToken`
elsewhere in the same file) stores `token_hash` and returns the raw value
exactly once at creation. Invites reuse that shape rather than inventing a
new one.

## Goals / Non-Goals

**Goals:**

- Close self-registration server-side the moment any account exists — the
  spec-level requirement, not just a UI affordance.
- Let an admin generate, list, and revoke invite tokens without giving up
  control of the target username/display name.
- Keep the WebAuthn ceremony itself unchanged; the invite only gates
  _whether_ `BeginRegistration` is allowed to proceed for a given username.

**Non-Goals:**

- No email delivery of invite links — the admin copies a URL out of band,
  same as every other manual step this project already expects of a
  self-hosted operator.
- No invite-based _login_ recovery (lost-passkey account recovery is a
  separate, already-unscoped problem — `RevokeUser` existing today is the
  current answer: revoke, then re-invite).
- No role beyond admin/non-admin; invites don't carry a role choice.

## Decisions

**Invite storage: new `invites` table, hashed token, mirroring `api_tokens`.**
Columns: `token_hash TEXT PRIMARY KEY`, `username TEXT NOT NULL`,
`display_name TEXT NOT NULL`, `created_by TEXT NOT NULL REFERENCES
users(id)`, `expires_at TIMESTAMP NOT NULL`, `consumed_at TIMESTAMP`
(nullable — NULL means outstanding). Storing only the hash means a leaked
database dump can't be replayed into a registration, the same reasoning
`api_tokens` already applies to its own `token_hash`. Alternative
considered: store invites as signed, stateless tokens (HMAC over
username+expiry, no DB row). Rejected because it can't support admin-listed
"outstanding invites" or revoke-before-use without still keeping a
denylist somewhere — at that point it's the same table with extra steps.

**Username is fixed by the admin at invite time, not chosen by the
invitee.** `BeginRegistration` already keys everything off username; a
token that let the invitee pick any username would just be a differently-
shaped version of today's open registration. The admin's `POST
/api/admin/invites` call takes `{username, displayName}` and returns
`{token, expiresAt}`.

**TTL: 1 hour, fixed (not admin-configurable).** Long enough for the admin
to hand off a link and the invitee to act on it in one sitting, short
enough that a stale, unconsumed invite isn't a standing credential.
Matches the order of magnitude of `ceremonyTTL` (5 minutes, for the much
shorter WebAuthn round trip) scaled up for a human-relayed link instead of
a same-session browser API call.

**`BeginRegistration` signature grows a token parameter; the "no invite
needed" path is only reachable when `HasAnyRegisteredUser` is false.**
Concretely:

```
if hasAdmin {
    invite, err := s.store.ConsumeInviteIfValid(ctx, token, username) // atomic
    if err != nil { return nil, ErrInvalidInvite }
    displayName = invite.DisplayName // admin's choice wins, not the client's
}
```

Consuming the invite happens in `BeginRegistration`, not
`FinishRegistration`, so a token can't be raced into starting two
concurrent ceremonies for the same username; `ConsumeInviteIfValid` does
the existence/expiry/consumed check and the `consumed_at` write in one
transaction. If `FinishRegistration` never completes (ceremony timeout),
the invite is still spent — consistent with how `DeleteUnregisteredUser`
already treats an abandoned _account_ as reclaimable, but an invite has no
equivalent reclaim path in this design (see Open Questions).

**Frontend: `/login` reads registration availability from the server, not
a client-side guess.** A small unauthenticated `GET /api/auth/registration-status`
(or folded into an existing public endpoint) returns whether the instance
has zero users, so the login page can decide whether to show the bootstrap
"Register a new passkey instead" button at all. An invite link is
`/login?invite=<token>`; when present, the page skips the username/display-
name fields entirely (both are already fixed by the invite) and shows only
the "Create passkey" action, calling the same `/api/auth/register/begin`
with the token attached instead of a typed username.

**Admin UI reuses the existing admin page's table pattern.** A new
"Invites" section alongside the existing user table
(`web/src/routes/(app)/admin/+page.svelte`): a form to issue one
(username, display name), a table of outstanding invites with a copy-link
button and a revoke action, mirroring the existing revoke/remove pattern
in `internal/api/admin.go`.

## Risks / Trade-offs

- **Losing the only admin account with no outstanding invite and no
  self-registration path is now a hard lockout.** → Documented operational
  mitigation only (this project has no email/SMS out-of-band channel to
  build a reset flow on): the README gains a note that losing every admin
  passkey with no other admin means restoring the SQLite file from backup.
  No new code; out of scope for this change.
- **Invite token in a URL can end up in browser history, a chat log, or a
  proxy's access log.** → Short TTL (1 hour) and single-use bound the
  exposure window; this is the same trade-off any invite-link system
  (Nextcloud, GitHub org invites) already accepts.
- **A revoked or expired invite's row lingers in the table forever.** →
  Acceptable at this scale (a handful of users); no cleanup job is being
  added. Revisit only if the table's growth ever becomes a real concern.

## Migration Plan

Additive schema change (`CREATE TABLE IF NOT EXISTS invites ...` in
`Store.Init`, same pattern as every other table there) — no backfill, no
data migration. Deploying the new binary is the whole rollout: existing
sessions and users are untouched, and the only immediately-visible
behavior change is that self-registration stops working once the first
account already exists (true today in every real deployment that has
already bootstrapped its admin). No rollback concern beyond redeploying
the previous binary, which leaves the unused `invites` table in place
harmlessly.

## Open Questions

- Should an invite whose registration ceremony was begun but never
  finished (browser closed mid-prompt) be reclaimable the same way
  `DeleteUnregisteredUser` reclaims an abandoned username today, or should
  the admin just issue a fresh invite? Leaning toward "admin issues a
  fresh invite" (simpler, and the admin already has to be involved) but it
  doesn't change the spec or task breakdown either way — deferrable to
  implementation.
