# pr-branch-auto-update Specification

## Purpose

Lets a user opt a repo, or every tracked repo at once, into automatically bringing a behind pull request's branch up to date, without a manual click per PR.

## Requirements

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

### Requirement: Automatic updates treat bot-managed pull requests through their own actions

The system SHALL NOT automatically update a release-please, Dependabot or Renovate pull request's branch with the generic branch update. A Dependabot pull request gets Dependabot's own rebase command, and a recreate command when that rebase leaves its CI failing (#540). A Renovate pull request gets its own rebase label (#541). A pull request is Renovate's when its author is one of GitHub's Renovate App slugs (`renovate`, `renovate[bot]`) or one of the logins the user lists as Renovate in Settings, matched ignoring case (#1062). The system does not assume any other account name, since a Forgejo or GitLab instance names its Renovate account itself. A release-please pull request is left alone, since release-please regenerates it.

#### Scenario: A release-please PR is skipped by auto-update

- **WHEN** a scheduled refresh finds a behind release-please pull request on a repo with automatic branch updates enabled
- **THEN** the system takes no automatic action on it

#### Scenario: A Dependabot PR is rebased through Dependabot

- **WHEN** a scheduled refresh finds a behind Dependabot pull request on a repo with automatic branch updates enabled
- **THEN** the system comments Dependabot's rebase command instead of updating the branch itself, and comments its recreate command if the rebase leaves CI failing

#### Scenario: A Renovate PR is rebased through Renovate

- **WHEN** a scheduled refresh finds a behind Renovate pull request on a repo with automatic branch updates enabled
- **THEN** the system adds Renovate's rebase label instead of updating the branch itself

#### Scenario: A Renovate account the user lists is recognised on any forge

- **WHEN** a scheduled refresh finds a behind pull request whose author is a login the user listed as Renovate in Settings, on a repo with automatic branch updates enabled
- **THEN** the system adds Renovate's rebase label instead of updating the branch itself, and the pull request offers Renovate's rebase and no Update branch

#### Scenario: An unlisted account is a person's pull request

- **WHEN** a behind pull request's author is neither a GitHub Renovate App slug nor a login the user listed
- **THEN** the system treats it as an ordinary pull request and updates its branch the generic way
