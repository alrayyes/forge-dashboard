# Spec Delta

## Purpose

A draft pull request can't be merged on GitHub, so the dashboard doesn't offer it.

## ADDED Requirements

### Requirement: A draft pull request never offers Merge

The system SHALL block Merge on a draft pull request, whatever merge state the forge reports for it.

#### Scenario: A draft that GitHub reports as clean

- **WHEN** a pull request is a draft and GitHub reports its merge state as clean
- **THEN** Merge is blocked with a reason saying it's a draft
