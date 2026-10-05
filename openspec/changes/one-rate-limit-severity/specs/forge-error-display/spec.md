# Spec Delta

## Purpose

Every client grades a rate-limit budget the same way, because the server does it.

## ADDED Requirements

### Requirement: The server grades a rate-limit budget in four steps

The system SHALL grade each rate-limit budget as `ok`, `warning` (under 20% left), `low` (under 5% left) or `exceeded` (nothing left and the reset not yet seen to pass), so no client needs a threshold of its own.

#### Scenario: A budget under 20% but not under 5%

- **WHEN** a budget has between 5% and 20% of its limit left
- **THEN** its severity is `warning`

#### Scenario: A banner for a warning

- **WHEN** a budget's severity is `warning`
- **THEN** the board shows no rate-limit banner for it
