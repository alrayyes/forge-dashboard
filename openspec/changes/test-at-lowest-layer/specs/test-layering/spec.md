# Spec Delta

## Purpose

Decide which test tier proves a frontend behaviour, and what evidence is needed
before a slower test is added or an existing one removed.

## ADDED Requirements

### Requirement: Behaviour is tested at the lowest tier that can see it

A new frontend behaviour or bug fix SHALL be tested at the lowest tier able to
fail for it: a unit test, then a component test, then an end-to-end journey.

#### Scenario: A rule that is a pure function

- **WHEN** a change alters logic that depends only on its inputs
- **THEN** it is covered by a unit test and no end-to-end test is added for it

#### Scenario: Layout or focus of one component

- **WHEN** a change affects only how one component looks or takes focus
- **THEN** it is covered by a component test with no application server

### Requirement: A new end-to-end test states why

A pull request that adds an end-to-end test MUST say why no lower tier would
catch the fault.

#### Scenario: Review of a new browser test

- **WHEN** a pull request adds an end-to-end test without that reason
- **THEN** review asks for the reason or for a lower-tier test

### Requirement: A removed test has a proven replacement

An end-to-end test SHALL be removed only after its replacement has been seen to
fail when the behaviour is deliberately broken.

#### Scenario: Moving a test down

- **WHEN** a pull request deletes an end-to-end test
- **THEN** it names the replacement and records the failure seen with the
  behaviour broken

### Requirement: Journeys that stay end to end are listed

The repository SHALL keep a written list of the whole journeys that are tested
end to end.

#### Scenario: Deciding whether a test belongs

- **WHEN** a contributor wants to add an end-to-end test
- **THEN** it is on the list, or the pull request justifies it
