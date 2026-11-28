# Proposal

## Why

A test at a low tier is simpler to read and change than one that drives the
whole app. `CONTRIBUTING.md` already says to pick the lowest tier that can see a
behaviour (`bun test`, then a story, then Playwright), added with the component
tier in #3626.

The end-to-end tier is still the largest and keeps growing: from 2026-11-14 to
`3d9d756b` it went from 265 spec files and about 2,300 tests to 356 and 3,150.
The unit tier grew faster in the same period (about 1,400 tests to 2,400), so
this is not a claim that the rule is ignored. It is that browser tests are the
hardest to follow, and some behaviour can only be reached through them because
it exists only inside page-sized components.

The aim is clearer tests and code. Faster CI is not a goal of this change.

## What Changes

- Make the existing tier rule hard to miss and ask for it in review: a new
  end-to-end test says why no lower tier would catch the fault.
- Add plain component tests, without a story, for edge cases and regressions.
- Keep a written list of the journeys that stay end to end.
- Set the rule that a component's tests move down by default when it is split
  out. The moves themselves belong to the frontend split change.

Not in scope: the frontend restructure, run time (#5034), the end-to-end shard
limit (#3477), the Playwright worker count, and a new audit of the suite.

## Capabilities

### New Capabilities

- `test-layering`: which tier proves a behaviour, and what has to be shown
  before a higher-tier test is added or moved.

### Modified Capabilities

None.

## Impact

`CONTRIBUTING.md`, `docs/storybook.md`, a new `CLAUDE.md`,
`.github/PULL_REQUEST_TEMPLATE.md`, `scripts/check-doc-links.ts`,
`web/vitest.config.ts`, a component test setup file, `web/package.json` and
`bun.lock` (one pinned test dependency). No product behaviour changes.

## Prior work

- #3494 audited the suite for duplicated tests.
- `docs/e2e-audit.md` (from #3593) classes the specs. It is a dated snapshot and
  this change does not refresh it.
- #3626 chose stories run by Vitest as the component tier and kept
  `vitest-browser-svelte` for a component with no story.
- #3749 to #3752 trimmed specs that repeated lower tests.
- #3800 moved further groups down, each with a proof that the replacement fails.

## Sources

- Martin Fowler, [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html)
- Storybook, [Vitest addon](https://storybook.js.org/docs/writing-tests/integrations/vitest-addon)
- Vitest, [browser mode](https://vitest.dev/guide/browser/)
