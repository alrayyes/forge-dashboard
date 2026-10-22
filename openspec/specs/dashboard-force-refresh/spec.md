# dashboard-force-refresh Specification

## Purpose

Lets a signed-in user trigger an immediate refresh of their own dashboard,
out of band from the scheduled background poll, so a transient forge
outage doesn't have to wait for the next scheduled tick to clear.

## Requirements

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

### Requirement: A triggered refresh needs a signed-in session

The system SHALL refuse a refresh trigger that carries no valid session or
API token. An instance has one owner and one dashboard, so there is no
other dashboard to refresh.

#### Scenario: Refresh without a session

- **WHEN** a request without a valid session or API token triggers a refresh
- **THEN** the system answers 401 and refreshes nothing

### Requirement: Rapid repeated triggers don't multiply forge requests

The system SHALL prevent a rapid sequence of refresh triggers from
multiplying the number of requests made against either forge beyond what
one refresh pass already makes.

#### Scenario: Two triggers in quick succession

- **WHEN** a user triggers a refresh twice in quick succession
- **THEN** the forges are not queried twice as a result
