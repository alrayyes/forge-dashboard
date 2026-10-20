# Spec Delta

## Purpose

Turn a burst of webhook events for one repo into one scoped refresh, so a single push doesn't cost one refresh per event.

## ADDED Requirements

### Requirement: Scoped webhook refreshes are debounced per repo

When a webhook names a repo, the dashboard SHALL start a refresh for that repo only after a quiet window of 2 seconds with no further event for the same forge and repo. Events arriving inside the window SHALL extend it. A burst SHALL NOT hold the refresh back more than 5 seconds after its first event. Both durations are constants, not settings.

#### Scenario: A burst causes one refresh

- **WHEN** 10 events for one repo arrive within the window
- **THEN** exactly one scoped refresh runs for that repo, after the window closes

#### Scenario: A burst that never goes quiet

- **WHEN** events keep arriving for 8 seconds
- **THEN** a refresh runs 5 seconds after the first event, and the events after it start a new window

#### Scenario: Two repos in one window

- **WHEN** events arrive for two repos inside the same period
- **THEN** each repo refreshes once, independently

#### Scenario: A lone event

- **WHEN** one event arrives and no other follows
- **THEN** one refresh runs 2 seconds after it

### Requirement: An event that cannot be scoped is not delayed

A webhook that names no repo, or a forge that cannot refresh one repo, SHALL still fall back to a full refresh without waiting for a window.

#### Scenario: Ping delivery

- **WHEN** a payload names no repository
- **THEN** the existing full-refresh fallback runs at once
