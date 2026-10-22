# 2. One user per instance

Status: accepted (2026-10-18)

## Context

An instance used to hold many people. Registration was by invite, an admin area
listed and removed users, a dashboard could be shared with another user, and
the backend kept one in-memory aggregator per user, with a user id on nearly
every row and cache key.

The product is going to be offered as a hosted service where each customer gets
their own instance. Nothing in an instance is ever shared between people, so
the multi-user machinery was cost with no use. It also widened the attack
surface: invite links, an admin role, and reads that cross from one user's data
into a second user's view.

## Options

- **Keep multi-user.** Nothing to migrate, but every feature still has to think
  about whose data it touches, and the invite and admin paths stay exposed.
- **Hide it, keep the plumbing.** Remove the invite, admin and sharing screens
  and endpoints, but leave the per-user aggregators, keys and user id columns.
  It is a smaller change, but the code that exists only for extra users stays
  to be maintained, tested and secured for nobody.
- **Remove all of it.** Take out invites, the admin area, sharing, and then the
  per-user plumbing itself.

## Decision

An instance has exactly one user, the owner. The third option, in separate
pull requests, one feature each.

- The first visit registers a passkey and becomes the only user. Registration
  then closes for good. More passkeys for the same user stay possible from
  Settings, for recovery. Losing every passkey is fixed from the host with
  `reset-passkeys`.
- Invites, the admin area and dashboard sharing are gone, along with the
  `owner` argument on the dashboard and the MCP reads.
- One aggregator replaces the manager of per-user ones. The user id column is
  dropped from settings, sessions, API tokens, passkey labels and the request
  log, and webhook routing uses one token.
- A database that still holds several users keeps the oldest user who has a
  passkey and deletes the others, once, after copying the file. The new version
  then rebuilds the tables without the user id. How to upgrade is
  in [Running](../running.md#before-you-upgrade).

Multi-tenancy, organisations and billing are out of scope. A hosted offering
runs one instance per customer.

## Consequences

- The API lost its invite, user and sharing operations and the `owner`
  parameter. That is a breaking change, so the client libraries regenerate.
- Upgrading from a multi-user release takes two steps, because the second
  needs the first's clean-up to have run. Both copy the database first.
- Anyone who can reach a new instance before the owner registers becomes the
  owner. Register straight away, or restrict access until you have.
- Isolation between customers comes from running separate instances, not from
  code. A bug here can no longer leak one user's data to another, because there
  is no other user.
- The end-to-end tests can no longer register a fresh user per test. They use a
  fresh server and database instead.

## Sources

- OWASP [Multi-Tenant Application Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)
  on instance-per-tenant as the strongest isolation
