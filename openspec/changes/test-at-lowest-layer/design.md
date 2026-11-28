# Design

## Context

See `proposal.md`. Three tiers exist: `bun test` for pure modules, Storybook
`play` functions in Chromium (`bun run test:components`), and Playwright against
a real binary.

## Goals / Non-Goals

**Goals:** tests that are simple to read, a home below the browser journeys for
edge cases, and a clear rule for what stays end to end.

**Non-Goals:** faster CI, a target test count, a file size rule, the frontend
restructure, and a sweep through areas that are not being changed.

## Decisions

1. **Keep the three tiers; add a plain component test beside stories.** A story
   is for a state worth looking at. An edge case or regression goes in a plain
   component test, so the catalogue doesn't fill with them. Alternative:
   everything as stories, which needs no dependency but buries the catalogue.
2. **Plain component tests are named `*.component.ts`.** `bun test web/src`
   would pick up `*.test.ts` and `*.spec.ts` and cannot render Svelte.
3. **They look like the app.** Their setup file loads the same global stylesheet
   and fonts as `web/.storybook/preview.ts`, and stands in for the `$app/*`
   modules a component imports.
4. **Needing a browser does not make a test end to end.** Layout, focus and
   styles of one component can be asserted in a component test. A test stays end
   to end when it needs the server, sign-in, the stream, navigation or the
   assembled page (scroll position across live updates).
5. **A pointer, not a copy.** `CONTRIBUTING.md` stays the home of the rule. A
   short `CLAUDE.md` points at it, and the pull request template asks the
   question. Alternative: a CI check that fails on any new spec, rejected
   because some new specs are right and a bypass would become routine.
6. **Moving down is the default at extraction.** No trial and no timing
   threshold. Clearer tests are reason enough.
7. **Prove before deleting.** Break the code on purpose and see the replacement
   fail. The pull request names the replacement for every moved test.
8. **Two pull requests per extraction.** First move the code with the old tests
   unchanged. Then add the lower tests and delete the browser copies.

## Risks / Trade-offs

- Coverage lost in a move -> decision 7.
- A component test passes while the assembled page is broken -> decision 4 and
  the journey list.
- Review wording gets answered by rote -> accepted; the question is still asked.
