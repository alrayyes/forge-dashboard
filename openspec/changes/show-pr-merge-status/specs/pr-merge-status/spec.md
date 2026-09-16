## Purpose

Reports whether each pull request can actually be merged — blocked or
conflicting state, and whether auto-merge is scheduled on it — sourced from
whichever forge the PR belongs to, with an explicit "not reported" state
where a forge's API genuinely can't answer, rather than a guessed default.

## ADDED Requirements

### Requirement: Pull request rows report blocked/conflicting state

The system SHALL report, for each pull request, whether it is blocked from
merging or has a merge conflict, sourced from the owning forge's own
reported state.

#### Scenario: A GitHub pull request with a real conflict

- **WHEN** a GitHub pull request has a merge conflict
- **THEN** the dashboard shows a blocked/conflict indicator on that pull
  request's row

#### Scenario: A clean, mergeable pull request shows no indicator

- **WHEN** a pull request is clean and mergeable
- **THEN** no blocked/conflict indicator appears on its row

### Requirement: Pull request rows report auto-merge status

The system SHALL report, for each pull request, whether auto-merge is
currently enabled on it, sourced from the owning forge's own reported
state.

#### Scenario: Auto-merge enabled

- **WHEN** a pull request has auto-merge enabled
- **THEN** the dashboard shows an auto-merge indicator on that pull
  request's row

#### Scenario: Auto-merge not enabled

- **WHEN** a pull request does not have auto-merge enabled
- **THEN** no auto-merge indicator appears on its row

### Requirement: A forge that cannot report a state says so explicitly

The system SHALL distinguish "this forge cannot report this state" from a
default value, for any pull request field a forge's API does not expose.

#### Scenario: Forgejo auto-merge status

- **WHEN** a pull request belongs to a Forgejo instance
- **THEN** its auto-merge status is reported as not available from that
  forge, never as a false "not enabled"

### Requirement: No merge action is exposed anywhere in the system

The system SHALL NOT expose any control, endpoint, or affordance that
triggers merging a pull request — reporting mergeable/blocked and
auto-merge state is read-only, the same as every other piece of data this
system surfaces.

#### Scenario: No merge control on a pull request row

- **WHEN** a pull request row is rendered, regardless of its mergeable or
  auto-merge state
- **THEN** no button, link, or other control on that row can trigger a
  merge
