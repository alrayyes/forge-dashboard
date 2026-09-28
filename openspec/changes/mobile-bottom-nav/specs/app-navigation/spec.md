# Spec Delta

## Purpose

Defines the signed-in shell's persistent navigation: which routes are
reachable, how the current page and admin-only links are shown, and how
sign-out works, across both the desktop header chrome and a mobile bottom
tab bar.

## ADDED Requirements

### Requirement: Mobile bottom tab bar

On a narrow viewport, the signed-in shell SHALL provide a bottom tab bar
giving one-tap access to Home, Insights, Webhooks, and Settings, so
primary navigation never wraps or crowds the header.

#### Scenario: Bottom tab bar shown at mobile width

- **WHEN** a signed-in user views any `(app)` page at a viewport narrow
  enough to trigger the mobile layout
- **THEN** a bottom tab bar with Home, Insights, Webhooks, and Settings
  tabs is visible, and the header no longer wraps its nav links onto a
  second line

### Requirement: Current page indication

Exactly one navigation control — in the header or the bottom tab bar,
whichever is showing — SHALL indicate the current page at any time.

#### Scenario: Active tab matches the current route

- **WHEN** the current page is one of Home, Insights, Webhooks, or
  Settings
- **THEN** the corresponding navigation control carries the current-page
  indicator (`aria-current="page"` and its visual state), and no other
  control does

### Requirement: Admin-only link visibility

The Admin navigation link SHALL be shown only to a session whose user is
an admin, and hidden otherwise, regardless of which navigation surface
(header or bottom tab bar) is active.

#### Scenario: Non-admin session

- **WHEN** a signed-in, non-admin user views any `(app)` page
- **THEN** no visible navigation control links to Admin

#### Scenario: Admin session

- **WHEN** a signed-in admin user views any `(app)` page
- **THEN** an Admin navigation control is visible

### Requirement: Sign-out

Activating the sign-out control SHALL end the session and return the
user to the login page, from any navigation surface that exposes it.

#### Scenario: Sign out from the header

- **WHEN** a signed-in user activates the sign-out control
- **THEN** their session ends and they are returned to `/login`

### Requirement: Accessible navigation

Every navigation control, on both the header and the bottom tab bar,
SHALL be reachable by keyboard and pass an automated accessibility scan
at WCAG 2.1 AA.

#### Scenario: Automated accessibility scan

- **WHEN** an axe-core scan runs against an `(app)` page at a mobile
  viewport with the bottom tab bar visible
- **THEN** the scan reports zero violations
