# Spec Delta

## Purpose

Reports whether each pull request can actually be merged.

## ADDED Requirements

### Requirement: Optional checks don't block Merge

The system SHALL keep Merge enabled on a pull request whose only failing or
pending checks are not required by branch protection, and SHALL still show
those checks.

#### Scenario: An optional check fails

- **WHEN** a GitHub pull request has `mergeStateStatus` UNSTABLE and every required check passes
- **THEN** Merge is enabled and the failing check stays visible

#### Scenario: A required check is pending

- **WHEN** a required check is pending
- **THEN** Merge is blocked with "Waiting for CI"

### Requirement: Drafts can't be merged

The system SHALL block Merge on a draft pull request, with the reason "Draft".

#### Scenario: A clean draft

- **WHEN** a pull request is a draft and otherwise clean
- **THEN** Merge is blocked with the reason "Draft"
