# Spec Delta

## Purpose

Decide when background refreshes run, so they cost less when webhooks work, never starve a user's action, and rest when nobody is looking.

## ADDED Requirements

### Requirement: The full refresh interval stretches when webhooks are healthy

While every tracked repo has a healthy webhook, the full refresh interval SHALL stretch to four times `REFRESH_INTERVAL`, up to 2 hours (never below `REFRESH_INTERVAL`). When any tracked repo loses a healthy webhook, it SHALL return to `REFRESH_INTERVAL`. An explicitly set `REFRESH_INTERVAL` SHALL be the lower bound.

#### Scenario: Full coverage

- **WHEN** every tracked repo has a healthy webhook
- **THEN** the next full refresh is scheduled at the stretched interval

#### Scenario: Coverage drops

- **WHEN** one repo's webhook turns unhealthy
- **THEN** the next full refresh is scheduled at `REFRESH_INTERVAL`

### Requirement: Background work leaves a reserve for user actions

On a forge that reports a budget, a background full refresh, poll or hook-maintenance call SHALL NOT start when it would take the remaining budget to or under the reserve; a scoped webhook refresh is held only when the budget is spent. A user's Merge, Update branch, bot rebase, Close, Enable auto-merge or queued action SHALL still run. A forge that reports no budget has no reserve.

#### Scenario: Budget at the reserve

- **WHEN** remaining GraphQL budget is at or under the reserve and a background refresh is due
- **THEN** it waits for the reset

#### Scenario: User merges at the reserve

- **WHEN** the same budget state holds and the user clicks Merge
- **THEN** the merge request is sent

### Requirement: Background refreshes rest when nobody is using the dashboard

When no browser session or API client has made a request for the idle period, the next background full refresh SHALL be skipped or slowed. On the first request after that, one incremental refresh SHALL run to catch up. Webhook-driven refreshes SHALL still run.

#### Scenario: Idle

- **WHEN** nothing has requested the dashboard for the idle period
- **THEN** the scheduled full refresh does not run

#### Scenario: Return

- **WHEN** a request arrives after an idle period
- **THEN** one incremental refresh runs
