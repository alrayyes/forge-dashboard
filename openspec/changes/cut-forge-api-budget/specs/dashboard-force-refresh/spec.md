# Spec Delta

## ADDED Requirements

### Requirement: A forced refresh is not held back by background rules

A user's "Refresh now" SHALL run immediately (subject to the existing five-second cooldown between forced refreshes) and in full. It SHALL NOT wait for a webhook debounce window, the idle pause, or the stretched interval, and the budget reserve SHALL NOT block it unless the forge's budget is spent.

#### Scenario: Forced during idle

- **WHEN** the dashboard is in idle mode and the user presses "Refresh now"
- **THEN** a full refresh runs immediately

#### Scenario: Forced at the reserve

- **WHEN** remaining budget is at the reserve but not spent
- **THEN** the forced refresh still runs
