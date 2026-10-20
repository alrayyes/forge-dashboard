# Spec Delta

## Purpose

Make the safety-net full refresh cost almost nothing when nothing changed, by fetching only the repos that did.

## ADDED Requirements

### Requirement: A full refresh fetches only repos that changed

A full refresh SHALL first make a cheap probe of the forge's repos, compare it with the last snapshot, and fetch pull requests and issues in full only for repos the probe reports changed. A repo missing from the last snapshot, a repo whose last fetch failed, and a repo with no confirmed healthy webhook SHALL count as changed.

#### Scenario: Nothing changed

- **WHEN** the probe reports no change since the last snapshot and every repo has a healthy webhook
- **THEN** the refresh makes no per-repo query and the snapshot's unchanged rows stay as they were

#### Scenario: Two repos changed

- **WHEN** the probe reports two changed repos
- **THEN** only those two are fetched in full

#### Scenario: Repo without a webhook

- **WHEN** a repo has no confirmed webhook
- **THEN** it is fetched in full on every full refresh

### Requirement: A probe that cannot be trusted forces a full fetch

If the probe fails, or the forge's source offers none, the refresh SHALL fetch every repo as it does today.

#### Scenario: Probe fails

- **WHEN** the probe request fails
- **THEN** the full refresh fetches every repo and the failure is logged

### Requirement: A force refresh is always full

A user's "Refresh now" SHALL fetch every repo, whatever the probe says.

#### Scenario: Force with nothing changed

- **WHEN** the user forces a refresh and the probe reports no change
- **THEN** every repo is still fetched

### Requirement: The query asks only for fields that are used

The pull request and issue queries SHALL request only fields the web page or the API responses use.

#### Scenario: Unused field removed

- **WHEN** a field is no longer read by any mapper
- **THEN** a test fails if the query still selects it
