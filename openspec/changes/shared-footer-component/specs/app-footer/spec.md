# Spec Delta

## Purpose

Defines the footer shown on every page that has one — the
mirror/credentials statement, the source link, the running version, and
which self-referential links (Disclaimer, Privacy, Release history) are
suppressed when already on that page.

## ADDED Requirements

### Requirement: Footer content

Every page with a footer SHALL show the mirror/credentials statement, a
link to the project's source, and the running server's version.

#### Scenario: Footer present on every page that has one

- **WHEN** any page with a footer loads
- **THEN** the footer shows "Read-only mirror of both forges · credentials
  never leave forge-dashboard's backend" and a link to the project source

### Requirement: Version display

The footer SHALL show the running server's version once known: a plain
"dev build" label for an unreleased build, or the version number linked
to its matching GitHub release otherwise.

#### Scenario: Released version

- **WHEN** the server reports a released version (not "dev")
- **THEN** the footer shows that version number, linked to
  `https://github.com/alrayyes/forge-dashboard/releases/tag/v<version>`

#### Scenario: Dev build

- **WHEN** the server reports its version as "dev"
- **THEN** the footer shows "dev build" with no release link

#### Scenario: Version unknown

- **WHEN** the version hasn't resolved yet, or the request fails
- **THEN** the footer shows no version text and no release history link,
  rather than an error or a stale value

### Requirement: Self-referential link suppression

The footer SHALL link to release history, Disclaimer, and Privacy,
except that each link is omitted on the page it points to.

#### Scenario: Release history link hidden on its own page

- **WHEN** the release history page itself loads
- **THEN** the footer shows no link to release history

#### Scenario: Disclaimer link hidden on its own page

- **WHEN** the disclaimer page itself loads
- **THEN** the footer shows no link to Disclaimer

#### Scenario: Privacy link hidden on its own page

- **WHEN** the privacy page itself loads
- **THEN** the footer shows no link to Privacy

#### Scenario: All three links shown elsewhere

- **WHEN** any page other than release history, disclaimer, or privacy
  loads
- **THEN** the footer shows links to all three
