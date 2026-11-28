# Design

## Context

See `proposal.md`. Three tiers exist: `bun test` for pure modules, Storybook
`play` functions in Chromium (`bun run test:components`), and Playwright against
a real binary. Story files run one at a time (`fileParallelism: false`) because
parallel runs missed Vitest's ready timeout on a busy machine.

The audit's CSV (`docs/e2e-audit/spec-classes.csv`) puts 196 specs in the
browser-only class and 157 in the class that needs a lib or component test. Its
"movable" figure, about 1,230 s of about 2,900 s summed spec time, is an upper
bound by its own account and not a measured saving.

## Goals / Non-Goals

**Goals:** slow the growth of the browser suite, give edge cases a home below it,
and learn from a measured trial whether wider moves pay off.

**Non-Goals:** a target test count, a file size rule, the frontend restructure,
and a new audit of the whole suite.

## Decisions

1. **Keep the three tiers; add a plain component test beside stories.** A story
   is for a state worth looking at. An edge case or regression goes in a plain
   component test, so the catalogue doesn't fill with them. #3626 named
   `vitest-browser-svelte` for this. Alternative: everything as stories, which
   needs no dependency but buries the catalogue.
2. **Browser-only does not mean end to end.** Layout, focus and styles can be
   asserted in either component form, since both run in Chromium. A test stays
   end to end when it needs the server, sign-in, the stream, navigation, or the
   assembled page (global styles, scroll position across live updates).
3. **A pointer, not a copy.** `CONTRIBUTING.md` stays the home of the rule. A
   short `CLAUDE.md` points at it, and the pull request template asks the
   question. Alternative: a CI check that fails on any new spec, rejected for
   now because some new specs are right and a bypass would become routine.
4. **Prove before deleting.** Break the code on purpose and see the replacement
   fail, as #3749 to #3753 and #3800 did. The pull request names the replacement
   for every deleted test.
5. **Two pull requests per extraction.** First move the code with the old tests
   unchanged. Then add the lower tests and delete the browser copies.
6. **Stop after the trial and decide.** Earlier moves saved little each. If the
   trial removes no more browser-test time than normal run-to-run variation, or
   adds more component time than it removes, stop and take the figures to the
   owner before moving anything else. The tier rule and review question stay.

## Measurements

Taken before the first change, after the trial and after each extraction, from
several CI runs and not one: end-to-end spec files and tests, summed e2e spec
time, per-shard run time, component job time, whole-run wall time, and retried
tests.

## Risks / Trade-offs

- Coverage lost in a move -> decision 4.
- A component test passes while the assembled page is broken -> decision 2 and
  the journey list.
- More component tests slow a job that already runs several minutes -> measure
  it; parallel story files only if repeat runs stay free of timeouts.
- Review wording gets answered by rote -> compare new spec and component test
  counts at each measurement.

## Open Questions

- Which component the trial uses. It must already stand alone and still have
  movable assertions according to the audit.
