## Why

Every filter dimension (forge, repo, label, title, author, created, updated,
group-by) already exists twice today — once for the Pull Requests board, once
for the Issues board — each with its own independent state, and a recent
change (#207) mirrored that same per-board duplication onto the Insights
page, copy-pasting ~150 lines of near-identical filter logic because the two
pages share no JS module. The forge filter is a closed `<select>` dropdown,
so it's easy to have it set away from "All" without noticing. And there's no
way to filter Pull Requests and Issues together, even though most fields —
forge, repo, label, author, title, created, updated, group-by — already mean
the same thing on both.

## What Changes

- Replace the forge `<select>` dropdown with an always-visible segmented
  control (All / GitHub / Forgejo) on both the main dashboard and Insights,
  so the active filter is never hidden behind a closed control.
- Replace the two independent per-board filter rows on the main dashboard
  with one shared top-level filter/group bar — forge, repo, label, author,
  title, created, updated, group-by — driving the Pull Requests and Issues
  boards from the same values at once.
- Keep the two controls with no equivalent on the other entity type attached
  to their own board rather than promoting them to the shared bar: CI status
  (Pull Requests only) and "Hide Dependency Dashboard" (Issues only).
- Replace Insights' own independently duplicated filter rows with the same
  shared bar and underlying filtering logic, extracted into one script both
  pages load instead of two hand-maintained copies. Insights keeps its
  existing, deliberate exclusion of Created/Updated/Status from what it
  shows (those already have their own charts there) — only the
  implementation duplication goes away, not that design decision.
- Each board keeps its own visible "N of M shown" count so filtering state
  stays legible per board even though the controls that set it no longer
  sit inside that board's own header.

No backend or API change: filtering already runs client-side against an
already-fetched snapshot.

## Capabilities

### New Capabilities

- `dashboard-filtering`: the shared filter/group behavior for the Pull
  Requests and Issues boards — the forge segmented control, the unified
  filter bar's fields and their shared meaning across both entity types, the
  board-specific controls that stay separate, and reuse of this same
  behavior on both the main dashboard and the Insights page.

### Modified Capabilities

None — no specs exist yet for this project.

## Impact

- `internal/api/static/index.html` — restructure the two per-board filter
  rows into one shared top-level bar; keep CI status and Hide Dependency
  Dashboard attached to their own board.
- `internal/api/static/app.js` — replace the two independent `state.filters`
  objects and the per-board `.col-filter` wiring with one shared filter
  state driving both boards; replace the forge `<select>` with a segmented
  control.
- `internal/api/static/insights.html` / `internal/api/static/insights.js` —
  adopt the same shared bar and state instead of Insights' own duplicated
  cookie/matching/populate-select logic; keep the existing Created/Updated/
  Status exclusion.
- Likely a new shared script (e.g. `internal/api/static/filters.js`) both
  `index.html` and `insights.html` load via a plain `<script src>` tag (no
  bundler in this project), to stop the two pages' filter logic from
  drifting apart the way `app.js` and `insights.js` already have.
- `internal/api/static/style.css` — layout for the new shared bar.
- The `forge-board-filters` cookie's shape changes from two independent
  per-board objects to one shared object plus the two board-specific
  controls; existing persisted cookies from before this change go stale and
  fall back to defaults.
- No changes to `api/openapi.yaml`, the Go backend, or any HTTP endpoint —
  this is a pure frontend restructuring of client-side filtering.
