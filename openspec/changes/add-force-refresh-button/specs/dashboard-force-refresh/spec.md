## Purpose

Lets a signed-in user trigger an immediate refresh of their own dashboard,
out of band from the scheduled background poll, so a transient forge
outage doesn't have to wait for the next scheduled tick to clear.

## ADDED Requirements

### Requirement: A signed-in user can trigger an immediate refresh

The system SHALL let a signed-in user with saved forge credentials trigger
an immediate refresh of their own dashboard, and reflect the result
without waiting for the next scheduled background refresh.

#### Scenario: Refresh updates the dashboard immediately

- **WHEN** a signed-in user with saved credentials triggers a refresh
- **THEN** the dashboard updates from the result of that refresh, not the
  next scheduled poll

#### Scenario: No credentials saved yet

- **WHEN** a signed-in user with no saved forge credentials triggers a
  refresh
- **THEN** the system reports that no refresh is running for them, rather
  than a silent failure

### Requirement: A triggered refresh is scoped to the requester's own dashboard

The system SHALL only ever refresh the requesting user's own dashboard,
never another user's, regardless of dashboard-sharing permissions.

#### Scenario: Viewing a shared dashboard offers no refresh trigger

- **WHEN** a user is viewing a dashboard another user shared with them
- **THEN** they have no way to trigger a refresh of that other user's
  dashboard

### Requirement: Rapid repeated triggers don't multiply forge requests

The system SHALL prevent a rapid sequence of refresh triggers from
multiplying the number of requests made against either forge beyond what
one refresh pass already makes.

#### Scenario: Two triggers in quick succession

- **WHEN** a user triggers a refresh twice in quick succession
- **THEN** the forges are not queried twice as a result
