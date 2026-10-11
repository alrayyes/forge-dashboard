# Spec Delta

## Purpose

Checks the dashboard's view of a GitHub pull request against GitHub's own
answer, on a fixture repository that holds one pull request per state.

## ADDED Requirements

### Requirement: One verdict per pull request

The system SHALL compare, for every open pull request in the fixture repo, the
dashboard's Merge, draft, behind and auto-merge state with GitHub's, and print
one row per pull request saying what GitHub says, what the dashboard says and
whether they agree.

#### Scenario: Every state agrees

- **WHEN** the fixture is built and the test runs
- **THEN** each pull request has a row, and the run passes

#### Scenario: A new disagreement

- **WHEN** the dashboard and GitHub differ on a pull request that no entry explains
- **THEN** the run fails and names the pull request and the field

### Requirement: Known differences are listed and kept honest

The system SHALL list every deliberate or tracked difference by pull request
title, with its reason or ticket, and SHALL fail the run when a listed pull
request now agrees.

#### Scenario: A deliberate difference

- **WHEN** a pull request is empty or stacked on another
- **THEN** the dashboard blocks Merge with that reason, GitHub allows it, and the row says so

#### Scenario: A fix lands

- **WHEN** a listed difference no longer exists
- **THEN** the run fails until the entry is removed

### Requirement: The owner's merge past requirements is an expected difference

The system SHALL treat GitHub offering the owner a merge of a BLOCKED pull
request, and the dashboard not offering it, as expected rather than a bug.

#### Scenario: Review required

- **WHEN** a pull request is BLOCKED and `viewerCanMergeAsAdmin` is true
- **THEN** the dashboard blocks Merge and the row reads "expected, owner bypass"

### Requirement: Merge picks a method the repository accepts

The system SHALL merge with a method GitHub accepts when merge commit, squash
or rebase is the only one allowed, and when the pull request's base branch
requires linear history.

#### Scenario: Only one method is allowed

- **WHEN** the repo allows only squash
- **THEN** Merge squashes and GitHub accepts it

#### Scenario: The base branch requires linear history

- **WHEN** the base branch requires linear history and all three methods are allowed
- **THEN** Merge does not make a merge commit
