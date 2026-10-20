# Spec Delta

## Purpose

Let an unchanged answer cost nothing, and keep that saving across a restart.

## ADDED Requirements

### Requirement: Every REST read is conditional where the server allows it

Each REST GET the dashboard makes to a forge SHALL send `If-None-Match` when it holds an ETag for that request and credential, and SHALL treat `304` as "reuse the cached body". A GET that is not cached SHALL be one the server gives no ETag for.

#### Scenario: Unchanged resource

- **WHEN** the same REST GET is made twice and the resource did not change
- **THEN** the second request is answered `304`, counted as a 304, and returns the first body

#### Scenario: Changed resource

- **WHEN** the resource changed
- **THEN** the response replaces the cached body and ETag

### Requirement: Cache entries are keyed by credential

ETag entries SHALL be keyed by forge, credential identity and request URL, and SHALL NOT carry a user id. An entry made under one credential SHALL NOT be sent for another.

#### Scenario: Credential changes

- **WHEN** the connected credential is replaced
- **THEN** requests do not send the old credential's ETags

### Requirement: The cache survives a restart

The dashboard SHALL persist ETag entries, the last snapshot, and the webhook-check results, and SHALL load them at start.

#### Scenario: First refresh after a restart

- **WHEN** the dashboard restarts and the first refresh runs
- **THEN** its conditional requests send the persisted ETags

### Requirement: A persisted snapshot is served marked stale

Until the first refresh after a start succeeds, the dashboard SHALL serve the persisted snapshot with a stale mark. The mark SHALL clear when that refresh succeeds. If persisted data cannot be read, the dashboard SHALL start empty and log it.

#### Scenario: Page load before the first refresh

- **WHEN** a page loads before the first refresh finishes
- **THEN** it receives the persisted snapshot marked stale

#### Scenario: Corrupt store

- **WHEN** the persisted rows cannot be read
- **THEN** the dashboard starts with an empty cache and refreshes normally
