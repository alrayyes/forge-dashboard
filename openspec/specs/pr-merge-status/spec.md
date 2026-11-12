# pr-merge-status Specification

## Purpose

Reports whether each pull request can actually be merged — blocked or
conflicting state, and whether auto-merge is scheduled on it — sourced from
whichever forge the PR belongs to, with an explicit "not reported" state
where a forge's API genuinely can't answer, rather than a guessed default.

## Requirements

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

### Requirement: Pull request rows report a branch that is behind its base

The system SHALL report a pull request as behind when its base branch has
commits its head lacks, whatever merge state the forge reports and whether or
not the repo requires branches to be up to date. Behind SHALL NOT block a
merge: Merge stays as available as the forge makes it, and Update branch is
offered. On GitHub, `mergeStateStatus` is only a reliable "behind" when it
says so (`BEHIND`), so every other state is settled by one batched
`Ref.compare` lookup per refresh, which GitHub costs at one GraphQL point
however many pull requests it covers (#495, #1183).

#### Scenario: Behind in a repo that does not require up-to-date branches

- **WHEN** a GitHub pull request is mergeable (`CLEAN`) and its base branch has commits its head lacks
- **THEN** the pull request is reported as behind, Update branch is offered, and Merge stays allowed

#### Scenario: Not behind

- **WHEN** a GitHub pull request's base branch has no commits its head lacks
- **THEN** the pull request is not reported as behind

#### Scenario: The comparison is unavailable

- **WHEN** GitHub returns no comparison for a pull request, such as a deleted head
- **THEN** the pull request is not reported as behind

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

### Requirement: An armed pull request that is behind says whether that holds it

The system SHALL report, for each behind pull request, whether the base
branch's protection requires pull requests to be up to date (GitHub branch
protection `strict`, Forgejo `block_on_outdated_branch`), read from the forge
once per branch and cached, with no extra call per pull request on a refresh.
When the rule can't be read the answer SHALL be unknown, never guessed. An
armed pull request that is behind where the rule is on SHALL be reported as
waiting for the branch to be updated, with Update branch offered. Where the
rule is off or unknown, being behind SHALL NOT be reported as the hold (#3428).

#### Scenario: Armed and behind where up-to-date branches are required

- **WHEN** auto-merge is armed on a behind pull request and the base branch requires up-to-date branches
- **THEN** its auto-merge status is waiting with code `behind`, the row's chip reads "Waiting for update", and Update branch is offered

#### Scenario: Armed and behind where they are not required

- **WHEN** auto-merge is armed on a behind pull request and the base branch does not require up-to-date branches
- **THEN** its auto-merge status names the check that holds it, not being behind

#### Scenario: The protection can't be read

- **WHEN** the token can't read the base branch's protection
- **THEN** the rule is unknown, nothing is guessed, and being behind is not reported as the hold

#### Scenario: A refresh with several behind pull requests on one branch

- **WHEN** several pull requests behind the same base branch are refreshed within five minutes
- **THEN** the rule is read from the forge once

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
