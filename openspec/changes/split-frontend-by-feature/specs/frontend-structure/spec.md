## ADDED Requirements

### Requirement: API types come from the contract

The web app SHALL take the types of API requests and responses from types
generated from `api/openapi.yaml`. The generated output SHALL NOT be committed.

#### Scenario: The contract changes

- **WHEN** a field the web app reads is renamed in `api/openapi.yaml` and the
  web app is not updated
- **THEN** the type check in CI fails

### Requirement: Dashboard data has one source

Polled and streamed dashboard data SHALL go through one handler into one store,
which SHALL keep the latest data apart from the data shown and from row actions.

#### Scenario: A change arrives

- **WHEN** the stream or a poll reports a change and nothing is holding updates
- **THEN** every part of the page showing that row updates from the same data

#### Scenario: A change arrives while a menu is open

- **WHEN** a change arrives while the page is holding updates
- **THEN** what is shown stays put and the latest data is applied once the hold
  ends

### Requirement: Imports go downward

Code that has moved into a feature, data or UI folder SHALL import only from layers below it and from its own feature, and the build
SHALL check it. Two things are also allowed: importing a file that has not moved
yet, and the UI layer importing types, not values, from the data layer. A
relaxation SHALL state its reason where the rule is configured.

#### Scenario: A feature reaches into another

- **WHEN** a moved feature imports from another feature
- **THEN** CI fails

#### Scenario: Shared code reaches up

- **WHEN** the data or UI layer imports a feature or a route
- **THEN** CI fails

### Requirement: Styles live with their component

A component's styles SHALL live with it. The global stylesheet SHALL hold only
colours, spacing, theme, fonts, element defaults, styles for rendered HTML and
styles of areas not yet moved.

#### Scenario: An area has moved

- **WHEN** an area has moved into components
- **THEN** its own classes are gone from the global stylesheet and the page
  looks the same

### Requirement: The frontend is forge-agnostic outside setup

Outside connection settings, setup and listed prose, the web app SHALL decide
behaviour and wording from forge data the API sends, not from a forge's name, and the build SHALL check for forge identifiers and
product names.

#### Scenario: A forge name creeps back

- **WHEN** code outside the exceptions refers to a forge by its identifier or product name
- **THEN** CI fails

### Requirement: Unknown is not no

A forge fact the server does not know SHALL be reported and shown as unknown.

#### Scenario: An unknown capability

- **WHEN** the server cannot tell whether a forge allows something
- **THEN** the page does not say that it is not allowed

### Requirement: Old saved filters are ignored safely

A saved filter in a format that is no longer converted SHALL be ignored, SHALL
NOT break the page and SHALL NOT be saved back.

#### Scenario: An old saved filter

- **WHEN** the page loads with a saved filter in an old format
- **THEN** it shows defaults for those fields and the next save omits the old
  keys

### Requirement: Moving code keeps behaviour

A pull request that moves frontend code SHALL keep behaviour unchanged, and the
existing tests SHALL pass before any is moved to another layer.

#### Scenario: An area is extracted

- **WHEN** an area moves into components
- **THEN** its existing tests pass without changes to what they assert
