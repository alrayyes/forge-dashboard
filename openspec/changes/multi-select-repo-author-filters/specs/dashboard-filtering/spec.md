# Spec Delta

## Purpose

The Repo and Author filters take several values and show what matches any of them, like the Label filter.

## ADDED Requirements

### Requirement: Repo and Author take several values and match any of them

The system SHALL let a user pick several repos and several authors in the shared filter bar and SHALL show an item that matches any picked repo and any picked author. A control with nothing picked SHALL not filter. A repo SHALL stay forge-qualified, so one name on two forges is two choices. A value saved as a single repo or author SHALL read back as a list of one.

#### Scenario: Two repos are picked

- **WHEN** a user ticks two repos
- **THEN** both boards show items in either repo and the control reads "2 repos"

#### Scenario: Two authors are picked

- **WHEN** a user ticks two authors
- **THEN** both boards show items by either author and the control reads "2 authors"

#### Scenario: An author matches as a whole login

- **WHEN** an author is picked or saved, for example `ann`
- **THEN** items by `ann` show in any case, and items by `annabel` do not, where the filter used to match any login containing the saved text

#### Scenario: A partial login saved by hand

- **WHEN** the saved author is a part of a login, for example `ren` for `renovate[bot]`
- **THEN** it is not on offer, so it is set aside and named under the filter bar with a Clear button, and it is dropped once the author control changes

#### Scenario: A saved pick over the new budget

- **WHEN** a pick saved by an earlier build is longer than 1000 characters as the cookie writes it
- **THEN** it is cut to fit when the page loads, without a notice

#### Scenario: A repo on two forges

- **WHEN** a repo name exists on two forges
- **THEN** each forge is a named group of choices, and one picked repo is named with its forge in the button and the chip

#### Scenario: A single saved value

- **WHEN** the saved filters hold one repo or one author from before there was a list
- **THEN** the control shows that one ticked and nothing needs migrating

#### Scenario: A pick the page does not offer

- **WHEN** a saved repo or author is not on offer on the page
- **THEN** that value is set aside and said so, and the other picks stay

#### Scenario: Too many values

- **WHEN** a user has ticked 20 repos or authors
- **THEN** the other boxes are disabled, and the server refuses a longer saved pick

### Requirement: Repo and Author choices show a logo or an avatar

The system SHALL show a repo's logo and an author's avatar beside the name in the choices and on the filter chips when the data has one, and an initial otherwise or when the image fails to load. The image SHALL be decorative and SHALL load only over https.

#### Scenario: No image

- **WHEN** a repo has no logo or an author has no avatar
- **THEN** the choice shows the first letter of the name

#### Scenario: The image fails

- **WHEN** an avatar does not load
- **THEN** the image is removed and the initial stays

## MODIFIED Requirements

### Requirement: Insights reuses the shared filter state, scoped to what it displays

The system SHALL apply the shared forge, repo, label, author, and title filter values to the Insights page's charts, using the same persisted state as the main dashboard, with the same Repo and Author controls, while not applying or displaying created, updated, CI-status, or group-by on Insights.

#### Scenario: Picks made on the dashboard carry into Insights

- **WHEN** a user ticks two repos on the main dashboard and then opens the Insights page
- **THEN** the Insights charts reflect both repos and the control shows both ticked
