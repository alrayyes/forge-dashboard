# Proposal

## Why

Every PR that's behind its base branch has to be brought up to date with a manual "Update branch" click today. A user who wants this kept current on one or more repos has no way to say so once and stop thinking about it — see [alrayyes/forge-dashboard#365](https://github.com/alrayyes/forge-dashboard/issues/365).

## What Changes

- A per-user, per-repo `auto_update_branch` setting, persisted server-side.
- A bulk action that sets or clears the setting for every currently tracked repo at once, composing with (not overriding) later per-repo changes.
- The existing background refresh loop calls `UpdateBranch` automatically for any PR that's behind on a repo with the setting enabled — the same write the manual button already performs, just triggered by the poll instead of a click.
- Auto-sync respects the existing bot-managed-PR suppression (`isBotManagedPr`/`allowBotPrUpdates`) exactly as the manual button already does — it is not a second, independent gate.
- Settings UI: a per-repo toggle plus a bulk "all repos" control.

## Capabilities

### New Capabilities

- `pr-branch-auto-update`: automatic, per-repo-opt-in branch updates for behind pull requests, driven by the background refresh loop instead of a manual click, with a bulk on/off across all tracked repos.

### Modified Capabilities

(none — this adds a new capability rather than changing an existing one's requirements)

## Impact

- `internal/settings`: new per-repo settings table and store methods (get/set one repo, bulk set/unset all).
- `internal/dashboard`: the background refresh loop (`Manager`/`Aggregator`) gains a write side-effect it's never had before — today it's read-only.
- `internal/api`: new endpoints for per-repo and bulk auto-update-branch settings.
- `web`/`internal/api/static`: Settings UI additions — per this project's standing convention, touching `settings.html` means migrating it to SvelteKit as part of this work, not a minimal edit to the legacy static page.
