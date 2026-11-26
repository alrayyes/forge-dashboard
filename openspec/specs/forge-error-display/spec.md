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

### Requirement: A start-up gap is not drawn as an outage

The system SHALL mark a forge `starting`, with no error kind, while the rows
shown for it are the ones a previous run saved and no fetch from the forge has
answered in time since the app started, until `ForgeFailureThreshold` (3) passes
in a row have gone unanswered. While a forge is `starting` the dashboard SHALL
say the app is starting up and show when the data is from, and SHALL NOT draw an
unreachable chip, headline or banner for that forge. The first refresh that
reaches the forge replaces the mark with its real reachability.

#### Scenario: Opening the page right after a restart

- **WHEN** the page loads before the first refresh has finished and the
  forges carry the saved rows
- **THEN** each forge chip says it is starting up, a line says "Starting up,
  showing data from" the saved time, and no forge is called unreachable

#### Scenario: A first fetch that hangs

- **WHEN** the first fetch passes its deadline, or a pass is skipped because
  it is still running, and fewer than `ForgeFailureThreshold` passes in a row
  have gone unanswered
- **THEN** the forge stays `starting`, with no error kind, and is not called
  unreachable

#### Scenario: A first fetch that keeps going unanswered

- **WHEN** `ForgeFailureThreshold` passes in a row have gone unanswered,
  counting deadline and skipped passes together
- **THEN** the forge is no longer `starting`, its health carries the
  `unreachable` error kind and no cause, the saved rows stay, and the
  unreachable banner appears

#### Scenario: A good read after the outage

- **WHEN** a later fetch answers in time
- **THEN** the health carries no error and no cause, and the live control reads
  "Live"

#### Scenario: A forge that is really down at start-up

- **WHEN** the first refresh reports a forge as failing
- **THEN** the unreachable banner appears, as for any outage, and no chip is
  drawn for that forge unless it is also rate limited

#### Scenario: The first refresh finishes

- **WHEN** the first refresh answers for a forge
- **THEN** the starting notice and the forge's "starting up" chip clear, and
  its real reachability shows

#### Scenario: Saved main-branch rows after a restart

- **WHEN** the Main branches page shows rows saved by the last run for a
  forge that is starting
- **THEN** a notice says the app is starting up and the rows are the saved
  ones, and the "forge can't be read" notice is not shown for them

### Requirement: A slow forge's held rows say how old they are

While a forge's cause is `slow`, its health SHALL carry `rowsReadAt` and SHALL
NOT carry `staleSince` because of that cause. `rowsReadAt` is the time of the
last full read that answered, including one that could not read some
repositories, or, where webhook refreshes made every repository current after a
failed full refresh or a restart, the time of the last of those. Single rows MAY
be older or newer than it. The pages with forge health chips SHALL show "Slow to answer,
showing data from" that age. A forge with no such cause SHALL have neither the
field nor the line.

#### Scenario: A held pass

- **WHEN** a pass misses its deadline, or is skipped, and the rows are held
- **THEN** the health carries `rowsReadAt` and a line reads "Slow to answer,
  showing data from" that age, with no row action locked because of it

#### Scenario: A good read after a held pass

- **WHEN** a later pass answers in time
- **THEN** the health carries no `rowsReadAt` and the line is gone
