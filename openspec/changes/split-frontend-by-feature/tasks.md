Each task is one pull request unless it says otherwise; 2.1 and 4.1 are lists on
#5182, not pull requests. Each updates the docs it makes false.

Tasks 3.1, 3.2, 5.3 and 5.4 are extractions. Each moves the code and its styles
and adds the import rule for what it creates, with the old tests passing
unchanged. A following pull request then moves its tests down, as #5180 sets
out.

## 1. Types

- [ ] 1.1 Generate types from `api/openapi.yaml` in the build, uncommitted, and make an `api/` change run the web type check; verify `scripts/test-changed-areas.sh` covers it and a renamed field fails CI
- [ ] 1.2 Replace the hand-written API types, one pull request per group of consumers; verify no hand copy of a schema is left

## 2. Data store

- [ ] 2.1 List the dashboard's areas and their order on #5182; verify every part of `initDashboard` belongs to one
- [ ] 2.2 Choose the import-rule tool and add it with the `data` and `ui` rules; verify a deliberate upward import fails CI
- [ ] 2.3 Move poll and stream handling into one handler and store, behaviour unchanged; verify the existing tests pass unchanged, including the held-update ones

## 3. Components

- [ ] 3.1 Extract keyed row components, in as many pull requests as keeps each
      reviewable; verify focus stays on a row across an update and page screenshots match
- [ ] 3.2 Extract each further area on the list; verify its tests pass unchanged and
      page screenshots match
- [ ] 3.3 Remove `initDashboard`; verify the name no longer appears
- [ ] 3.4 Delete unused classes from the global stylesheet; verify no source names them and page screenshots match

## 4. Forge-agnostic

- [ ] 4.1 List on #5182 every place outside connections and setup that decides from a forge's name; verify the planned check would find each
- [ ] 4.2 Send each missing fact from the API, one pull request per fact; verify unknown is shown differently from no
- [ ] 4.3 Add the CI check with its listed exceptions; verify a deliberate branch on a forge name fails it

## 5. Other large files

- [ ] 5.1 Delete the old-format filter migrations and drop old keys on read; verify a saved filter in an old format, a bare author login included, loads
      defaults and is not saved back
- [ ] 5.2 Split `filters.ts` by job; verify its tests pass unchanged
- [ ] 5.3 Split the details dialog into header, description, comments and image viewer, one pull request each; verify its tests pass unchanged
- [ ] 5.4 After #5069, split Settings into one component per section, one pull request per section; verify its tests pass unchanged
