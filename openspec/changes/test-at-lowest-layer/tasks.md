# Tasks

## 1. Baseline and stop the growth

- [ ] 1.1 Record the baseline figures listed in `design.md` from several CI runs; verify they are posted on the tracking issue with run links
- [ ] 1.2 Add a short `CLAUDE.md` pointing at the tier rule in `CONTRIBUTING.md`; verify the link check passes
- [ ] 1.3 Add the "why not a lower tier" line to the pull request template and say in `CONTRIBUTING.md` that review asks for it; verify a new pull request shows it

## 2. Plain component tests

- [ ] 2.1 Add a pinned `vitest-browser-svelte` and a second Vitest project for plain component tests; verify `bun run test:components` runs both and a deliberately broken assertion fails it
- [ ] 2.2 Document when to write a story and when a plain component test; verify `CONTRIBUTING.md` says both
- [ ] 2.3 Try story files in parallel in CI on a throwaway branch; verify several repeat runs, then record the time and any timeouts and keep or drop the setting

## 3. Trial

- [ ] 3.1 Pick one standalone component with movable assertions in the audit; verify the choice and its spec are named on the tracking issue
- [ ] 3.2 Move its assertions down with a failure proof for each; verify the audit CSV is regenerated and the suite passes
- [ ] 3.3 Record the before and after figures; verify they are posted and the owner has decided whether to continue

## 4. Keep what stays

- [ ] 4.1 Write the list of journeys that stay end to end; verify `CONTRIBUTING.md` links it
- [ ] 4.2 Write down the two-pull-request order for moving tests during an extraction, and record the measurements to repeat after each one; verify the frontend restructure change refers to it when it is written

## Workflow follow-up

- Extractions and their test moves belong to the separate frontend change.
- Archive this change once the specs have landed.
