# Proposal

## Why

The browser suite keeps growing faster than the cheaper tiers. `CONTRIBUTING.md`
already says to pick the lowest tier that can see a behaviour (`bun test`, then a
story, then Playwright), added with the component tier in #3626. Between
2026-11-14 and 2026-11-28 `main` still gained about 105 end-to-end spec files and
9 story files. It has about 356 spec files and 3,150 tests.

The written rule is not enough on its own, and much of the UI can't be mounted
below the browser because it only exists inside page-sized components.

## What Changes

- Make the existing tier rule hard to miss and ask for it in review: a new or
  grown end-to-end spec says why no lower tier would catch the fault.
- Add plain component tests, without a story, for edge cases and regressions.
  #3626 left this open as the fallback.
- Look at running story files in parallel in CI.
- Trial a move on one component that already stands alone, measured, with a
  stop point before going further.
- Move tests along with each later component extraction, in a separate pull
  request from the code move.
- Keep a written list of the journeys that stay end to end.

Not in scope: the frontend restructure itself, the CI wall-time target (#5034),
the e2e shard limit (#3477) and the Playwright worker count (trialled in #5034).

## Capabilities

### New Capabilities

- `test-layering`: which tier proves a behaviour, and what has to be shown
  before a higher-tier test is added or removed.

### Modified Capabilities

None.

## Impact

`CONTRIBUTING.md`, a new `CLAUDE.md`, `.github/PULL_REQUEST_TEMPLATE.md`,
`web/vitest.config.ts`, `web/package.json` and `bun.lock` (one pinned test
dependency), `.github/workflows/ci.yml`, `tests/`, `web/src/lib` and
`docs/e2e-audit/`. No product behaviour changes.

## Prior work

- #3494 audited the suite for duplicated tests. Its follow-ups are closed.
- `docs/e2e-audit.md` (from #3593) classes every spec: browser-only, covered by
  Go, or movable to a lib or component test.
- #3626 chose stories run by Vitest as the component tier.
- #3749 to #3753 trimmed specs that repeated lower tests, each with a mutation
  proof.
- #3800 moved four groups. Each saved between about 0.1 s and 4.2 s of e2e
  time. It closed saying that further moves need a new ticket and measurement.

## Sources

- Martin Fowler, [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html)
- Storybook, [Vitest addon](https://storybook.js.org/docs/writing-tests/integrations/vitest-addon)
- Vitest, [browser mode](https://vitest.dev/guide/browser/)
