# Design

## Context

See proposal.md - Why. Today's background refresh loop (`internal/dashboard/manager.go`'s `Manager`/`Aggregator`) is strictly read-only: it fetches and re-fetches snapshots on a timer and via webhook-triggered refreshes, and nothing in this codebase writes back to a forge automatically. The only existing write path for updating a branch is the manual `POST /api/pull-requests/update-branch` handler, driven by a row click in `app.js`. The only existing per-repo persistence is `webhook_deliveries`, a passive record, not a user-set preference.

## Goals / Non-Goals

**Goals:**

- Let a user opt a repo (or all repos at once) into automatic branch updates.
- Reuse the exact same write path (`dashboard.BranchUpdater.UpdateBranch`) and bot-PR suppression logic the manual button already uses, rather than a parallel implementation.

**Non-Goals:**

- Auto-merge is out of scope — this only updates a behind branch, never completes a pull request. That's a materially different risk profile (reversible vs. not), already reflected in `doUpdateBranch` having no confirm step while `doMerge` does.
- No new retry/backoff design for a failed auto-update — it fails silently until the next refresh cycle tries again, the same cadence as any other polled fact in this app.

## Decisions

**Where the auto-update runs: inside the existing per-user refresh, not a separate job.** `Aggregator.Refresh` already has, per call, the freshly fetched `PullRequests` (including `Behind`) and the settings needed to build sources. Adding an auto-update pass right after a refresh completes (before publishing the snapshot, or as an immediately-following step) avoids standing up a second scheduler or duplicating the fetch. Alternative considered: a wholly separate ticker scanning all users' latest snapshots — rejected as needless duplication of state the aggregator already holds fresh.

**Gating logic is reused, not reimplemented.** `isBotManagedPr`/`allowBotPrUpdates` currently live in `app.js` (frontend-only). Since auto-update now needs the same decision server-side, this logic moves to (or is duplicated identically in) `internal/dashboard` or `internal/api`, and the frontend's manual-click path calls the same function rather than each maintaining its own copy of "is this PR bot-managed."

**Per-repo setting storage**: a new table, `(user_id, forge, repo_full_name, auto_update_branch BOOLEAN)`, following the exact shape `webhook_deliveries` already established for per-user-per-repo state — not a JSON blob on the existing `user_credentials` row, since that row's `Store.Set` is a full-row replace (see its own doc comment: "a Settings save is always a full form submit"), a poor fit for a value that can also be bulk-written across many repos in one action.

**Bulk action is a separate write, not a stored "apply to all" flag.** "Auto-update all repos" writes the per-repo row for every currently tracked repo at once; it is not a fourth persisted mode that would need reconciling against later per-repo edits. This matches the proposal's requirement that a later per-repo override composes cleanly — there is only ever one source of truth (the per-repo rows), never a bulk-flag-vs-per-repo-flag precedence question to get wrong.

## Risks / Trade-offs

- **A newly-tracked repo (added to the account after a bulk enable) isn't retroactively covered.** → Mitigation: acceptable for v1, since the bulk action already re-runs on demand; document this as expected behavior rather than silently auto-enrolling every future repo forever, which would be a surprising, hard-to-audit default.
- **Auto-update running inside the per-user refresh means a slow or failing forge write could slow down that user's whole refresh cycle.** → Mitigation: run auto-update writes concurrently (bounded), the same pattern `checkWebhooks` already uses for its own per-repo REST calls, and never let a single failed update block the snapshot from publishing.
- **Silent failures**: an auto-update that fails (permission, rate limit, real conflict) has no user-visible surface today, unlike a manual click's error banner. → Mitigation: out of scope for this change's first cut, but should reuse whatever comes out of `alrayyes/forge-dashboard#360`'s forge-error-messaging fix once that lands, rather than growing a second, parallel error surface.

## Migration Plan

Additive only — a new table (created via the existing `Init`-on-startup pattern every other store uses) and a new setting defaulting to off. No existing behavior changes for a user who never opts in.
