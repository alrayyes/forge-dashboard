# Spec Delta

## Purpose

Lets a user opt a repo, or every tracked repo at once, into automatically bringing a behind pull request's branch up to date, without a manual click per PR.

## ADDED Requirements

### Requirement: A repo can be individually opted into automatic branch updates

The system SHALL let a signed-in user enable or disable automatic branch updates for a single tracked repo, persisted per user per repo.

#### Scenario: Enabling auto-update for one repo

- **WHEN** a user enables automatic branch updates for a specific repo
- **THEN** that setting is saved and applies to that repo on future refreshes, independent of any other repo's setting

#### Scenario: Disabling auto-update for one repo

- **WHEN** a user disables automatic branch updates for a specific repo
- **THEN** that repo's behind pull requests are no longer updated automatically, and remain available for a manual Update branch click as today

### Requirement: All tracked repos can be enabled or disabled in one action

The system SHALL let a user enable or disable automatic branch updates for every currently tracked repo in a single action.

#### Scenario: Bulk-enabling every repo

- **WHEN** a user enables automatic branch updates for all repos
- **THEN** every currently tracked repo's setting is set to enabled in that one action

#### Scenario: A later per-repo change overrides the bulk action

- **WHEN** a user disables automatic branch updates for one specific repo after a bulk enable
- **THEN** only that repo stops auto-updating; every other repo enabled by the bulk action is unaffected

### Requirement: Auto-update only acts on a behind pull request in an enabled repo

The system SHALL automatically update a pull request's branch only when its repo has automatic branch updates enabled and the pull request is reported as behind its base branch.

#### Scenario: Automatic update on a behind PR

- **WHEN** a scheduled refresh finds a pull request that is behind its base branch, on a repo with automatic branch updates enabled
- **THEN** the system updates that pull request's branch the same way a manual "Update branch" click would

#### Scenario: No action on a repo without auto-update enabled

- **WHEN** a scheduled refresh finds a pull request that is behind its base branch, on a repo without automatic branch updates enabled
- **THEN** the system takes no automatic action; the pull request still shows a manual Update branch control

### Requirement: Automatic updates respect bot-managed pull request suppression

The system SHALL apply the same bot-managed pull request suppression to an automatic branch update that it already applies to a manual Update branch click, unless the user has separately allowed bot-managed pull request updates.

#### Scenario: A bot-managed PR is skipped by auto-update

- **WHEN** a scheduled refresh finds a behind pull request opened by release-please, Dependabot, or Renovate, on a repo with automatic branch updates enabled, and bot-managed pull request updates are not separately allowed
- **THEN** the system does not automatically update that pull request's branch

#### Scenario: A bot-managed PR is included when bot updates are allowed

- **WHEN** the same situation occurs but the user has allowed bot-managed pull request updates
- **THEN** the system automatically updates that pull request's branch like any other
