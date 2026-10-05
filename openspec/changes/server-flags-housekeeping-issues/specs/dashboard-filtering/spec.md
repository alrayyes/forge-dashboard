# Spec Delta

## Purpose

Every client lists and counts the same issues as real work.

## ADDED Requirements

### Requirement: The server decides which issues are housekeeping

The system SHALL flag each issue a bot keeps open and rewrites as `housekeeping`, and SHALL report how many of the issues are real work, so a client needs no rule of its own.

#### Scenario: Renovate's Dependency Dashboard

- **WHEN** an issue is titled "Dependency Dashboard"
- **THEN** it is returned with `housekeeping` true and is left out of `openIssueCount`

#### Scenario: A real issue

- **WHEN** an issue has any other title
- **THEN** it is returned with `housekeeping` false and counts in `openIssueCount`
