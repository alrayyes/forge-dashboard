# Spec Delta

## Purpose

A pull request GitHub can merge stays mergeable here, even while a check it doesn't require fails or runs.

## ADDED Requirements

### Requirement: An unstable pull request keeps Merge available

The system SHALL report GitHub's UNSTABLE merge state as `unstable` and SHALL keep Merge available on it.

#### Scenario: A non-required check is failing

- **WHEN** a pull request's only failing check isn't required by branch protection
- **THEN** its merge status is `unstable` and Merge is available

#### Scenario: A non-required check is still running

- **WHEN** a pull request's only running check isn't required by branch protection
- **THEN** its merge status is `unstable` and Merge is available

#### Scenario: A required check is failing or running

- **WHEN** a required check is failing or running
- **THEN** GitHub reports the pull request as blocked and Merge stays blocked
