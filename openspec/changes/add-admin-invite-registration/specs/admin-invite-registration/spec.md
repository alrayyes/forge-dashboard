# Spec Delta

## Purpose

Governs how new accounts come to exist after the very first one: the first
completed registration bootstraps the instance's admin, and every account
after that can only be created by the admin issuing a single-use invite.

## ADDED Requirements

### Requirement: First registration bootstraps the admin

When no user has completed registration, the instance SHALL accept an
unauthenticated, un-invited registration request and grant the resulting
account admin status.

#### Scenario: First-ever registration

- **WHEN** no account exists yet and someone completes the passkey
  registration ceremony with a chosen username and display name
- **THEN** the account is created with admin status

#### Scenario: Second unauthenticated attempt after bootstrap

- **WHEN** at least one account already exists and a registration request
  arrives with no invite token
- **THEN** the request is rejected and no account is created

### Requirement: Self-registration closes after bootstrap

Once any account exists, the registration endpoints SHALL require a valid,
unexpired, unconsumed invite token identifying the username being
registered. The login page's self-serve "register" entry point SHALL only
be shown when the instance has zero registered accounts.

#### Scenario: Registration UI on a fresh instance

- **WHEN** the login page loads and no account exists yet
- **THEN** the self-serve "register a new passkey" option is shown

#### Scenario: Registration UI once an account exists

- **WHEN** the login page loads and at least one account exists
- **THEN** the self-serve "register a new passkey" option is not shown, and
  registering requires an invite link

#### Scenario: Registering with an expired or already-consumed token

- **WHEN** a registration request presents a token that has expired or was
  already consumed by a completed registration
- **THEN** the request is rejected and no account is created

#### Scenario: Registering with a token for a different username

- **WHEN** a registration request presents a valid invite token together
  with a username other than the one the invite was issued for
- **THEN** the request is rejected and no account is created

### Requirement: Only an admin can create invites

Generating a registration invite SHALL require the requester to be an
authenticated admin. The invite SHALL specify the username and display name
the invitee will register under.

#### Scenario: Admin generates an invite

- **WHEN** an authenticated admin requests a new invite for a username that
  is not already registered
- **THEN** the system returns a single-use invite token and its expiry

#### Scenario: Non-admin attempts to generate an invite

- **WHEN** an authenticated non-admin user requests a new invite
- **THEN** the request is rejected and no invite is created

#### Scenario: Unauthenticated attempt to generate an invite

- **WHEN** an unauthenticated request asks to generate an invite
- **THEN** the request is rejected and no invite is created

#### Scenario: Admin generates an invite for an already-registered username

- **WHEN** an authenticated admin requests a new invite for a username that
  already has a completed registration
- **THEN** the request is rejected and no invite is created

### Requirement: Invite tokens are single-use and time-limited

An invite token SHALL be usable to complete at most one registration, and
SHALL stop being usable once it expires, whichever comes first.

#### Scenario: Invite consumed by successful registration

- **WHEN** a registration completes using a valid invite token
- **THEN** that token can never again be used to complete a registration

#### Scenario: Invite reuse after consumption

- **WHEN** a registration is attempted with a token that already completed
  a registration
- **THEN** the request is rejected and no account is created

### Requirement: Admin can view and revoke outstanding invites

An authenticated admin SHALL be able to list invites that have not yet been
consumed or expired, and revoke one before it is used.

#### Scenario: Admin lists outstanding invites

- **WHEN** an authenticated admin requests the list of outstanding invites
- **THEN** the system returns every invite that is neither consumed nor
  expired, including the username it was issued for and its expiry

#### Scenario: Admin revokes an outstanding invite

- **WHEN** an authenticated admin revokes an outstanding invite
- **THEN** that invite's token can no longer be used to complete a
  registration

#### Scenario: Non-admin attempts to list or revoke invites

- **WHEN** an authenticated non-admin user requests the invite list or
  attempts to revoke an invite
- **THEN** the request is rejected
