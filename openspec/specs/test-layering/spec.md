# test-layering Specification

## Purpose

Decide which test tier proves a frontend behaviour, and what is needed before a
slower test is added or an existing one is moved.

## Requirements

### Requirement: Behaviour is tested at the lowest tier that can see it

A new frontend behaviour or bug fix SHALL be tested at the lowest tier able to
fail for it: a unit test, then a component test, then an end-to-end journey.

#### Scenario: A rule that is a pure function

- **WHEN** a change alters logic that depends only on its inputs
- **THEN** it is covered by a unit test and no end-to-end test is added for it

#### Scenario: Layout or focus of one component

- **WHEN** a change affects only how one component looks or takes focus
- **THEN** it is covered by a component test with no application server

### Requirement: Journeys that stay end to end are listed

The repository SHALL keep a written list of the whole journeys that are tested
end to end.

#### Scenario: Looking up a journey

- **WHEN** a contributor wants to know whether a journey is tested end to end
- **THEN** the list names it and its spec files

### Requirement: A new end-to-end test states why

A pull request that adds an end-to-end test MUST say why no lower tier would
catch the fault. Naming a listed journey it newly covers is such a reason.

#### Scenario: Review of a new browser test

- **WHEN** a pull request adds an end-to-end test without that reason
- **THEN** review asks for the reason or for a lower-tier test

### Requirement: A moved test has a proven replacement

An end-to-end test that is moved down or dropped as a duplicate SHALL be removed
only after its replacement has been seen to fail with the behaviour deliberately
broken.

#### Scenario: Moving a test down

- **WHEN** a pull request deletes an end-to-end test for behaviour that remains
- **THEN** it names the replacement and records the failure seen

### Requirement: Tests move down when a component is split out

When a component is split out of a page, its tests SHALL move to the lowest tier
that can see their behaviour, except for the listed journeys.

#### Scenario: After an extraction

- **WHEN** a component has been split out with its old tests passing
- **THEN** a following pull request moves the tests that no longer need the app
