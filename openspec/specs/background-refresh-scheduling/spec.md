# background-refresh-scheduling Specification

## Purpose

Governs how and when the background refresh loop polls a forge, so that steady-state API usage stays modest now that webhook-triggered refreshes carry most of the real-time update burden.

## Requirements

### Requirement: The background poll defaults to a reconciliation-appropriate interval

The system SHALL default the background refresh interval to no less than 15 minutes, while still honoring an explicit `REFRESH_INTERVAL` override to a shorter or longer value.

#### Scenario: Default interval is reconciliation-appropriate

- **WHEN** the server starts with no `REFRESH_INTERVAL` set
- **THEN** the background refresh loop's interval is at least 15 minutes

#### Scenario: An explicit override still applies

- **WHEN** `REFRESH_INTERVAL` is set to a specific value
- **THEN** the background refresh loop uses that value instead of the default

### Requirement: The first refresh starts when the process does

The system SHALL start the background refresh as the process starts, from the credentials saved in Settings, without waiting for a session or a request. It SHALL start nothing when no credentials are saved or they cannot be read, and a sign-in SHALL NOT rebuild a refresh that is already running. `/readyz` SHALL NOT wait for this refresh.

#### Scenario: A restart refreshes before anyone asks

- **WHEN** the server starts with credentials saved in Settings
- **THEN** the first refresh begins without any request

#### Scenario: Nothing saved starts nothing

- **WHEN** the server starts with no credentials saved
- **THEN** no refresh starts until settings are saved

#### Scenario: Readiness stays independent of the forges

- **WHEN** the boot refresh is still running against a slow forge
- **THEN** `/readyz` answers ready

### Requirement: A webhook-triggered refresh is unaffected by the background poll's interval

The system SHALL continue to trigger an immediate refresh on a verified webhook delivery regardless of how long remains until the next scheduled background poll.

#### Scenario: Webhook refresh still fires immediately

- **WHEN** a signature-verified webhook delivery arrives
- **THEN** an immediate refresh happens for the instance's dashboard, independent of the background poll's own schedule

### Requirement: A critically low rate-limit budget delays the next scheduled poll

The system SHALL delay the next scheduled background refresh, rather than firing it immediately, when the most recently observed rate-limit budget for that forge was critically low.

#### Scenario: Low remaining budget postpones the next poll

- **WHEN** the most recent refresh reported a critically low remaining rate-limit budget for a forge
- **THEN** the next scheduled poll for that forge is delayed rather than firing at its normal interval

#### Scenario: Delay never exceeds the budget's own reset time

- **WHEN** a poll is delayed due to a low remaining budget
- **THEN** the delay never extends meaningfully past that budget's own reported reset time
