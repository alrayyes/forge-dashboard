## ADDED Requirements

### Requirement: API types come from the contract

The web app SHALL take the types of API requests and responses from types
generated from `api/openapi.yaml`, and SHALL NOT declare its own copies.

#### Scenario: The contract changes

- **WHEN** a field the web app reads is renamed in `api/openapi.yaml` and the
  web app is not updated
- **THEN** the type check in CI fails

### Requirement: Dashboard data has one source

Polled and streamed dashboard data SHALL be written to one store, and
components SHALL read it from there.

#### Scenario: A streamed change

- **WHEN** the stream reports a change to a row that is on screen
- **THEN** every part of the page showing that row updates from the same data

### Requirement: Imports go one way

A feature that has moved into its own folder SHALL NOT import another feature or
a route, and the build SHALL check it. A relaxation SHALL state its reason where
the rule is configured.

#### Scenario: A feature reaches into another

- **WHEN** a moved feature imports from another feature
- **THEN** CI fails

### Requirement: The frontend is forge-agnostic outside setup

Outside connection settings and setup, the web app SHALL decide behaviour and
wording from the forge data the API sends, not from a forge's name, and the
build SHALL check it.

#### Scenario: A forge name creeps back

- **WHEN** a change branches on a forge's name outside connection settings and
  setup
- **THEN** CI fails

### Requirement: Moving code keeps behaviour

A pull request that moves frontend code SHALL keep behaviour unchanged, and its
existing tests SHALL pass before they are moved to another layer.

#### Scenario: An area is extracted

- **WHEN** an area moves into components
- **THEN** its existing tests pass without changes to what they assert
