# Spec Delta

## Purpose

No client can make the server read an unbounded request body.

## ADDED Requirements

### Requirement: A request body is capped

The system SHALL refuse a request body larger than 1 MiB, except a forge's webhook delivery, which has its own larger cap.

#### Scenario: A declared length over the cap

- **WHEN** a request declares a body longer than the cap
- **THEN** the system answers 413 before reading it

#### Scenario: An ordinary body

- **WHEN** a request body is within the cap
- **THEN** the handler reads and answers it as before

### Requirement: Every request field is bounded

The system SHALL give each string, whole number and list a client can send a limit (`maxLength`, `maximum`, `maxItems`) in `api/openapi.yaml`, and refuse a value over it.

#### Scenario: A string over its maxLength

- **WHEN** a request carries a string longer than its schema's `maxLength`
- **THEN** the system answers 400 with a field error naming it

#### Scenario: A number over its maximum

- **WHEN** a request carries a number over its schema's `maximum`
- **THEN** the system answers 400 with a field error naming it
