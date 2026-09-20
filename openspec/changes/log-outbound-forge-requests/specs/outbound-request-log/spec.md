# Spec Delta

## Purpose

Persists a queryable record of every outbound request this service makes
to GitHub or Forgejo, so a rate-limit or connectivity incident can be
debugged after the fact from what actually happened on the wire, instead
of from stdout logs alone or from reasoning about the code.

## ADDED Requirements

### Requirement: Every outbound forge request is recorded

The system SHALL record one entry for every outbound request it makes to
GitHub or Forgejo, capturing the timestamp, the forge, the account whose
credential made the request, the method/endpoint (including whether it
was GraphQL or REST), the HTTP status returned, the outcome (success or a
classified `ForgeErrorKind`), and any rate-limit fields the response
carried (limit, remaining, reset time, and cost where the forge reports
one).

#### Scenario: A successful request is recorded

- **WHEN** a request to GitHub or Forgejo completes successfully
- **THEN** an entry is recorded with that request's timestamp, forge,
  account, method/endpoint, HTTP status, a success outcome, and any
  rate-limit fields the response carried

#### Scenario: A failed request is recorded with its classification

- **WHEN** a request to GitHub or Forgejo fails
- **THEN** an entry is recorded with the same fields as a successful
  request, plus the `ForgeErrorKind` the failure was classified as

#### Scenario: Recording a request never blocks or fails the request itself

- **WHEN** persisting a request's log entry fails (for example, a storage
  error)
- **THEN** the outbound request's own result is unaffected — the caller
  gets the same response or error it would have gotten if logging didn't
  exist

### Requirement: Only an admin can view or export the request log

The system SHALL restrict reading and exporting the request log to an
authenticated admin account, regardless of which account's credential
made the logged requests.

#### Scenario: A non-admin account is denied

- **WHEN** a signed-in account that isn't an admin requests the log or
  its export
- **THEN** the request is rejected and no log data is returned

#### Scenario: An admin sees requests made by every account

- **WHEN** an admin views the log
- **THEN** entries from every account's credential are visible, not just
  the admin's own

### Requirement: The log can be filtered and exported as CSV

The system SHALL let an admin filter the log by at least forge and
account, and export the currently filtered set as a CSV file.

#### Scenario: Filtering narrows the visible entries

- **WHEN** an admin filters the log by a specific forge or account
- **THEN** only entries matching that filter are shown

#### Scenario: Exporting downloads a CSV of the filtered set

- **WHEN** an admin exports the log while a filter is applied
- **THEN** the downloaded CSV contains exactly the entries matching that
  filter, with one row per entry and a header row naming each column

### Requirement: The log does not grow without bound

The system SHALL apply a retention policy that bounds how much log data
accumulates on a long-running instance, discarding the oldest entries
first once that bound is reached.

#### Scenario: Old entries are discarded once the retention bound is reached

- **WHEN** the request log has reached its configured retention bound
- **THEN** recording a new entry discards the oldest entry (or entries)
  needed to stay within that bound
