# dashboard-filtering Specification

## Purpose

Defines how a signed-in user filters and groups the Pull Requests and Issues
shown on the dashboard and Insights pages, and how forge, repo, label,
author, title, created, updated, and group-by apply consistently across
both entity types and both pages.

## Requirements

### Requirement: Forge selection is an always-visible segmented control

The system SHALL present forge selection (All, GitHub, Forgejo) as an
always-visible control that shows its current selection without being
opened, on both the main dashboard and the Insights page.

#### Scenario: Forge selection visible at rest

- **WHEN** a user loads the dashboard or Insights page
- **THEN** the current forge selection (All, GitHub, or Forgejo) is visibly
  shown without any interaction

#### Scenario: Switching forge

- **WHEN** a user selects a different forge option
- **THEN** the Pull Requests and Issues boards, or the Insights charts,
  immediately show only data from that forge, or all forges when "All" is
  selected

### Requirement: Shared filter bar applies to Pull Requests and Issues together

The system SHALL apply forge, repo, label, author, title, created, and
updated filter values, and the group-by selection, to both the Pull
Requests board and the Issues board at the same time, from one shared set
of controls on the main dashboard.

#### Scenario: Setting an author filters both boards

- **WHEN** a user sets the author filter to a specific username
- **THEN** both the Pull Requests board and the Issues board show only
  items whose author matches that username

#### Scenario: Clearing a shared filter restores both boards

- **WHEN** a user clears a previously set shared filter value
- **THEN** both boards immediately stop applying that filter

### Requirement: Board-specific controls stay scoped to their own board

The system SHALL keep CI status filtering scoped to the Pull Requests board
only, and the "Hide Dependency Dashboard" toggle scoped to the Issues board
only, with neither affecting the other board.

#### Scenario: CI status filter does not affect Issues

- **WHEN** a user filters the Pull Requests board by CI status
- **THEN** the Issues board's contents are unaffected

#### Scenario: Hide Dependency Dashboard does not affect Pull Requests

- **WHEN** a user toggles "Hide Dependency Dashboard" on the Issues board
- **THEN** the Pull Requests board's contents are unaffected

### Requirement: Each board shows how many items are hidden by active filters

The system SHALL display, per board, a count of currently shown items
against the total available, whenever any filter reduces what is
displayed.

#### Scenario: Filtered count reflects active filters

- **WHEN** one or more filters reduce the items shown on a board
- **THEN** that board displays a count showing how many items are shown out
  of the total available

### Requirement: Filter state persists across page loads

The system SHALL persist the shared filter values, the group-by selection,
and each board-specific control across page reloads for the same browser.

#### Scenario: Filters survive a reload

- **WHEN** a user sets filters and reloads the main dashboard
- **THEN** the same filter values are applied without the user re-entering
  them

### Requirement: Insights reuses the shared filter state, scoped to what it displays

The system SHALL apply the shared forge, repo, label, author, and title
filter values to the Insights page's charts, using the same persisted state
as the main dashboard, while not applying or displaying created, updated,
CI-status, or group-by on Insights — group-by has no equivalent there since
Insights renders charts, not a groupable row list.

#### Scenario: A filter set on the dashboard carries into Insights

- **WHEN** a user sets the author filter on the main dashboard and then
  opens the Insights page
- **THEN** Insights charts reflect that same author filter without the
  user re-entering it

#### Scenario: Created/updated/status filters do not apply on Insights

- **WHEN** a user has created, updated, or CI-status filters set from the
  main dashboard
- **THEN** the Insights page does not apply those filters to its charts and
  does not display controls for them
