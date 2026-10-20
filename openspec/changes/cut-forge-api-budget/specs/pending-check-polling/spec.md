# Spec Delta

## Purpose

Learn that a check finished or an auto-merge landed at the lowest cost: batched into one query, backed off when slow, and skipped where a webhook already says so.

## ADDED Requirements

### Requirement: Pending pull requests are polled in one query per forge

Where a forge can answer for many repos in one request, one poll SHALL check every pending pull request (CI pending, or GitHub auto-merge armed) with a single aliased query, not one request per repo.

#### Scenario: Twelve repos with pending pull requests

- **WHEN** the poll runs with pending pull requests in 12 GitHub repos
- **THEN** it makes one GraphQL request

#### Scenario: A forge that cannot batch

- **WHEN** the poll runs against a forge whose source cannot batch
- **THEN** it falls back to one scoped refresh per repo, as before

### Requirement: Long-pending pull requests are polled less often

A pull request that stays pending SHALL be polled at a growing interval, up to a cap of 15 minutes, and SHALL return to the base interval once its state changes.

#### Scenario: Interval grows

- **WHEN** a pull request is still pending after repeated polls
- **THEN** each next check for it waits longer than the last, up to the cap

#### Scenario: State changes

- **WHEN** its CI finishes or it merges
- **THEN** it leaves the pending set and a later pending pull request starts at the base interval

### Requirement: A repo with a confirmed check webhook is not polled

A repo whose webhook is confirmed to include check events SHALL NOT be polled while its check deliveries are on time. If no check delivery has arrived for it within an overdue period, it SHALL be polled until one does. A repo with no confirmed webhook, or one without check events, SHALL be polled.

#### Scenario: Healthy webhook

- **WHEN** a repo's webhook includes check events and a delivery arrived recently
- **THEN** its pending pull requests are not polled

#### Scenario: Overdue delivery

- **WHEN** the repo has a pending pull request and no delivery for longer than the overdue period
- **THEN** it is polled

### Requirement: One failing pull request does not fail the poll

A pull request that cannot be read in a batched poll (repo deleted, access removed) SHALL NOT stop the others from being checked.

#### Scenario: One alias fails

- **WHEN** one of 12 pending pull requests errors
- **THEN** the other 11 are updated and the failure is logged

### Requirement: A spent forge is not polled

A forge whose budget is spent SHALL NOT be polled until its reset.

#### Scenario: Budget spent

- **WHEN** a forge's rate limit is exhausted
- **THEN** the poll makes no request to it
