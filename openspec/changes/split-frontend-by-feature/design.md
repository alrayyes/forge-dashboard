## Context

See the proposal. Releases are continuous, so every step has to ship on its own.
Business rules already live behind the API
([ADR 0001](../../../docs/adr/0001-business-rules-live-behind-the-api.md)), and
forges already report their capabilities as data (#3969, #3972, #4073).

## Goals

- A feature can be changed by reading its own folder, the shared data layer and
  the shared UI.
- Each pull request leaves the app releasable.

## Non-Goals

- A separate frontend repository or service. CI time is mostly the browser
  suite and its queue, which a second repository would not shorten much.
- Redesigning screens.
- A file size limit.

## Decisions

**Order.** Each step lands before the next starts:

1. Test-layer rules (#5180).
2. Generated API types.
3. The store, then components, their styles and their tests, one area at a time.
4. The forge-agnostic contract, piece by piece.
5. The other large files. Settings may go earlier as a trial.

**Types are generated in the repo, not taken from the published SDK.**
`openapi-typescript` runs from `api/openapi.yaml`. The output isn't committed,
and CI type-checks against it. The published SDK would lag the server by a
release.

**One store first, components second.** Polling and the stream write to the
same store, with behaviour unchanged. Components then read from it. Splitting
the page first would spread the shared mutable state across files.

**Move code with its old tests, then move the tests.** The old tests prove the
move changed nothing. Moving both at once proves neither.

**Imports go one way.** Routes use features, features use data and UI, and
features don't import each other. The rule is added for a feature when it
moves. Where it would force worse code, relax it and say why.

**Styles are checked by screenshot.** Take screenshots before and after a style
move. The repo uploads screenshots today and no comparison step was found, so
the first style move adds one or compares by hand and says which.

## Risks

- A big refactor next to continuous releases. Mitigation: small pull requests,
  one area each, behaviour unchanged.
- Other work collides with moves. Mitigation: refactor tickets go first. A
  serious bug (a wrong or repeated action, lost data, an unusable page) jumps
  the queue. Other bugs and features in the area being moved wait. Backend and
  CI work carries on. The hold starts with the first extraction.
- Component tests need a second Vitest setup, because the current one runs only
  stories.
