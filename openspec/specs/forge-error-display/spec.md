# forge-error-display Specification

## Purpose

Classifies why a forge is unreachable into a small, coarse set of
actionable categories, and shows a friendly reason with the raw
technical detail available on demand, instead of a raw error string as
the primary text.

## Requirements

### Requirement: An unreachable forge shows a friendly, actionable reason

The system SHALL classify a forge-health error into one of a small set of
kinds (unreachable, unauthorized, not found, rate limited, unknown), and
show a friendly, kind-specific headline as the primary visible text
instead of the raw error string.

#### Scenario: A transient outage

- **WHEN** a forge cannot be reached at all (connection failure, timeout)
- **THEN** the dashboard shows a headline explaining the forge is
  temporarily unreachable and mentions the refresh button as a way to
  retry immediately

#### Scenario: A bad or revoked token

- **WHEN** a forge rejects a request as unauthorized or forbidden
- **THEN** the dashboard shows a headline directing the user to check
  their token in Settings

#### Scenario: A wrong instance URL

- **WHEN** a forge request resolves to a not-found response
- **THEN** the dashboard shows a headline directing the user to check
  the instance URL in Settings

#### Scenario: Rate limit exhaustion

- **WHEN** a forge reports its rate limit is exhausted
- **THEN** the dashboard shows a headline stating the rate limit was
  exceeded

#### Scenario: An unrecognized failure

- **WHEN** a forge error doesn't match any of the above kinds
- **THEN** the dashboard shows a generic headline naming the forge,
  rather than guessing at a specific cause

### Requirement: The raw technical error stays available on demand

The system SHALL keep the original, raw error message available behind a
disclosure the user can open, rather than discarding it or showing it as
the primary text.

#### Scenario: Opening the details

- **WHEN** a user opens the details disclosure on an unreachable forge
- **THEN** the raw technical error message is shown, exactly as the
  system would have shown it before this change

#### Scenario: Details stay closed by default

- **WHEN** the dashboard first renders an unreachable forge
- **THEN** the disclosure is collapsed and the raw error text is not
  visible until the user opens it

### Requirement: Classification degrades safely when the signal is ambiguous

The system SHALL fall back to the unknown kind rather than reporting an
incorrect specific kind when the underlying signal doesn't clearly match
one of the other kinds.

#### Scenario: An unrecognized status code or error shape

- **WHEN** a forge client's error doesn't carry a status code or signal
  the system recognizes
- **THEN** the error is classified as unknown rather than guessed at
