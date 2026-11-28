## 1. Before the first extraction

- [ ] 1.1 Land the test-layer rules (#5180)
- [ ] 1.2 Generate API types from `api/openapi.yaml` and check them in CI
- [ ] 1.3 Replace the hand-written API types

## 2. Dashboard

- [ ] 2.1 One store fed by polling and the stream, behaviour unchanged
- [ ] 2.2 Set up plain component tests
- [ ] 2.3 Move each area into components with its styles, then its tests, with
      the import rule for that feature
- [ ] 2.4 Remove `initDashboard`
- [ ] 2.5 Delete unused classes from the global stylesheet

## 3. Forge-agnostic contract

- [ ] 3.1 List what the frontend still decides from a forge's name
- [ ] 3.2 Send each missing fact from the API
- [ ] 3.3 Add the CI check

## 4. Other large files

- [ ] 4.1 Split Settings by job
- [ ] 4.2 Split the details dialog by job
- [ ] 4.3 Split `filters.ts` by job and delete the old-format migrations

## 5. Wrap up

- [ ] 5.1 Update `CONTRIBUTING.md` and `ARCHITECTURE.md`
