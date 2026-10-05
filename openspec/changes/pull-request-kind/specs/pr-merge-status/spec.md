# Spec Delta

## Purpose

Every client tells release, dependency and ordinary pull requests apart the same way, because the server says which is which.

## ADDED Requirements

### Requirement: The server reports each pull request's kind

The system SHALL report each pull request as `release`, `dependency` or `regular`: `release` when release-please's label is on it, `dependency` when Dependabot or Renovate opened it (in either spelling of the login, on either forge), and `regular` otherwise.

#### Scenario: A release label wins over a bot author

- **WHEN** a pull request has an `autorelease:` label and a bot author
- **THEN** its kind is `release`

#### Scenario: Dependabot in either spelling

- **WHEN** a pull request's author is `dependabot` or `dependabot[bot]`
- **THEN** its kind is `dependency`
