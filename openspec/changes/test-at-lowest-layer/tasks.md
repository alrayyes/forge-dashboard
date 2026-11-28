# Tasks

## 1. Make the rule hard to miss

- [x] 1.1 Add a short `CLAUDE.md` pointing at the tier rule in `CONTRIBUTING.md`, and have `scripts/check-doc-links.ts` read it; verify a broken link in `CLAUDE.md` fails the check
- [x] 1.2 Add the "why not a lower tier" line to the pull request template, and say in `CONTRIBUTING.md` that review asks for it, including on a pull request opened with its own body; verify both files say so

## 2. Plain component tests

- [ ] 2.1 Add a pinned `vitest-browser-svelte`, a second Vitest project for `*.component.ts` and its setup file; verify a first test passes including an assertion on a style from the global stylesheet, a broken assertion fails `bun run test:components`, and `bun run test:unit` still passes
- [ ] 2.2 Document when to write a story and when a plain component test in `CONTRIBUTING.md` and `docs/storybook.md`; verify both say the same

## 3. What stays and how tests move

- [ ] 3.1 Write the list of journeys that stay end to end in `CONTRIBUTING.md`; verify each entry names its spec files
- [ ] 3.2 Write down the move-down default, the failure proof and the two-pull-request order in `CONTRIBUTING.md`; verify all three are there

## Workflow follow-up

- Extractions and their test moves belong to the frontend split change.
- Archive this change once the specs have landed.
