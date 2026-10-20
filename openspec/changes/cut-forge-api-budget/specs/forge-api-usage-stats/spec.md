# Spec Delta

## Purpose

Say how many forge API calls the dashboard spends, on what, so a change to the refresh path can be shown to have worked and a rate-limit incident can be traced to its cause.

## ADDED Requirements

### Requirement: Forge API spend is counted by refresh type and repo

The dashboard SHALL count every outbound forge request under the refresh type that caused it (`full`, `scoped_webhook`, `ci_poll`, `auto_merge_poll`, `details`, `hook_maintenance`, `user_action`) and the repo it touched. For each it SHALL count REST calls, GraphQL calls, the GraphQL `rateLimit.cost` charged, and responses answered `304 Not Modified`. A request with no repo (an account-wide listing) SHALL be counted under an empty repo.

#### Scenario: A scoped webhook refresh is attributed to its repo

- **WHEN** a webhook for `owner/repo` triggers a scoped refresh that makes one GraphQL call costing 3
- **THEN** the counters for type `scoped_webhook` and repo `owner/repo` show one GraphQL call and a cost of 3

#### Scenario: A 304 is counted separately

- **WHEN** a conditional REST request is answered `304`
- **THEN** it increments the 304 counter and not the REST-call-charged counter

### Requirement: Counters are keyed by credential, never by user

Counters SHALL be labelled by forge and credential identity (the connected account or App installation), and SHALL NOT carry a user id.

#### Scenario: Two refreshes on one credential share counters

- **WHEN** two refreshes run on the same credential
- **THEN** their calls add to the same counter row

### Requirement: The counters are served on an authenticated endpoint

The dashboard SHALL serve the counters, the time they started counting, and the current rate-limit budgets from an authenticated API endpoint declared in the OpenAPI spec. Counters SHALL start from zero on each process start and say when they began.

#### Scenario: Unauthenticated request

- **WHEN** the endpoint is called without a session or API token
- **THEN** it responds `401`

#### Scenario: After a restart

- **WHEN** the endpoint is called right after a start
- **THEN** every counter is zero and `since` is the start time

### Requirement: Counting never changes a request's outcome

A failure to record a counter SHALL NOT change the result of the request it describes.

#### Scenario: Recording fails

- **WHEN** counting a request fails
- **THEN** the request's own result is returned unchanged and the failure is logged
