# Spec Delta

## Purpose

The rules that decide what a pull request may do hold for every client, not only the web page.

## ADDED Requirements

### Requirement: The server refuses an action the allowed actions block

The system SHALL refuse an action on a pull request that is on the user's board when its allowed actions block that action, answering with the blocked code and message and not asking the forge.

#### Scenario: Merging a draft through the API

- **WHEN** a client asks to merge a pull request on the user's board whose Merge is blocked because it is a draft
- **THEN** the system answers 409 with the blocked code and message and does not call the forge

#### Scenario: Merging an eligible pull request

- **WHEN** a client asks to merge a pull request whose Merge is allowed
- **THEN** the merge goes to the forge as before

#### Scenario: A pull request the board doesn't hold

- **WHEN** a client asks to merge a pull request that is not on the user's board
- **THEN** the request goes to the forge, which decides
