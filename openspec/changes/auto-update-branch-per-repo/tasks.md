# Tasks

## 1. Storage

- [ ] 1.1 Add a new per-user, per-repo settings table `(user_id, forge, repo_full_name, auto_update_branch)`, created via the existing `Init`-on-startup pattern, and verify it's created on a fresh DB and on one that predates it
- [ ] 1.2 Add store methods: get one repo's setting, set one repo's setting, bulk-set every currently tracked repo's setting, and verify each with a unit test

## 2. Shared bot-managed-PR gating

- [ ] 2.1 Move `isBotManagedPr`'s detection logic (release-please label, Dependabot/Renovate author) from `app.js` into a server-side location both the manual update-branch handler and the new auto-update pass can call, and verify the manual path's existing behavior is unchanged (existing Playwright coverage for `pull-request-update-branch.spec.js` stays green)

## 3. Auto-update in the refresh loop

- [ ] 3.1 After a per-user refresh fetches PRs, for each repo with `auto_update_branch` enabled, find behind PRs not excluded by bot-PR suppression, and call the existing `UpdateBranch` for each, bounded/concurrent the same way `checkWebhooks` already is
- [ ] 3.2 Verify a behind PR on an enabled repo gets updated on the next refresh, via an integration test against a fake forge client
- [ ] 3.3 Verify a bot-managed PR on an enabled repo is skipped unless bot-PR updates are separately allowed
- [ ] 3.4 Verify a repo without the setting enabled sees no automatic action

## 4. API

- [ ] 4.1 Add endpoints for getting/setting one repo's auto-update-branch setting and for the bulk all-repos action, matching this project's existing settings-endpoint conventions
- [ ] 4.2 Update `api/openapi.yaml` with the new endpoints and run `redocly lint`

## 5. Settings UI

- [ ] 5.1 Add a per-repo auto-update-branch toggle and a bulk "enable/disable for all repos" control to Settings, migrating `settings.html` to SvelteKit as part of this work (per this project's standing convention)
- [ ] 5.2 Playwright coverage for toggling one repo and for the bulk action

## 6. Docs

- [ ] 6.1 Update README/docs describing this setting, in the same commit as the feature per this project's own README convention
