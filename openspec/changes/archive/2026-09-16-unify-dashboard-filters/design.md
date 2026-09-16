## Context

See proposal.md - Why/What Changes for the motivation. Today's shape, as it
stands in `internal/api/static/`:

- `app.js` builds two independent `createBoard(...)` instances (PR, Issue),
  each with its own `state.filters` object, its own `.col-filter` wiring
  loop, and its own slice of the `forge-board-filters` cookie (keyed `'pr'` /
  `'issue'`).
- `insights.js` re-implements the same cookie helpers, `matchesFilters`, and
  populate-select logic independently, because there's no bundler and both
  pages load plain `<script src>` tags with no module system between them.
- Neither page has a page-level filter bar outside a board's own header,
  except Insights' existing `Filters` card, which is still internally split
  into PR/Issue sub-sections.

## Goals / Non-Goals

**Goals:**

- One shared filter state, computed once, read by both boards on the main
  dashboard and by the same charts-filtering logic on Insights.
- One implementation of filter matching, cookie persistence, and dropdown
  population, loaded by both pages instead of duplicated across `app.js` and
  `insights.js`.
- A forge control that's always visibly showing its current state.

**Non-Goals:**

- Not introducing a bundler, package manager, or ES-module build step — stays
  inside this project's existing "no frontend build step" constraint.
- Not changing what Insights displays or excludes (Created/Updated/Status
  stay out of its filter surface) — only removing the duplicated
  implementation behind that existing, deliberate choice.
- Not adding a way to give Pull Requests and Issues independently different
  values for the shared fields (e.g. different authors per board) — the
  proposal's confirmed decision is one shared meaning per field, not a
  per-board override layered on top.
- Not touching the backend, `api/openapi.yaml`, or any HTTP endpoint —
  filtering stays entirely client-side against an already-fetched snapshot.

## Decisions

**One shared filter object, plus two board-owned extra fields.** Replace the
two independent `state.filters` objects with a single shared object covering
forge, repo, label, author, title, created, updated, and groupBy. CI status
and "Hide Dependency Dashboard" have no equivalent on the other entity type,
so they stay as two extra fields owned and rendered by their own board
(`prStatus`, `hideDependencyDashboard`) rather than joining the shared
object — matching the proposal's decision not to force board-specific
concepts into the shared bar just for consistency's sake.

**Extract shared logic into one plain script, not an ES module.** A new
`internal/api/static/filters.js`, loaded via a plain `<script src="filters.js">`
tag before `app.js` and before `insights.js`, exposing the cookie
read/write, `matchesFilters`, and populate-select-preserving-selection
functions the two pages currently duplicate. Considered `<script
type="module">` with real `export`/`import` — rejected for now: every
current browser supports it, but the project's existing convention (plain
globals, `var`, no `import`) is consistent across every other script here,
and introducing the first module in the codebase is a bigger jump than this
change needs. A plain shared script keeps the diff to "stop duplicating,"
not "also change how scripts declare their boundaries."

**Segmented control as native radio inputs, not a custom widget.** The forge
control is a `<fieldset>` of `<input type="radio" name="forge">` +
`<label>`, visually styled as connected buttons (hide the native input,
style the label, standard CSS pattern). Considered a `<div
role="radiogroup">` of `<button>`s with JS-managed `aria-checked` state —
rejected because native radios give keyboard navigation, focus, and screen
reader semantics for free, and this project has no JS framework already
managing that kind of custom widget state elsewhere.

**Insights keeps masking fields it doesn't display, now against one object
instead of two.** Insights renders controls for forge/repo/label/author/
title only — group-by never applied there either, in the original
implementation or this one: it's a row-rendering layout choice with no
equivalent for a chart. When it calls the shared `matchesFilters`, it passes
a copy of the shared filter object with created/updated cleared and no
`prStatus`/`hideDependencyDashboard` at all — same masking concept as
today's `allowedCols` allowlist, just against a single shared object rather
than two duplicated ones. The "shared" part of this design is the state and
the matching/rendering logic, not a guarantee that every field is visible or
enforced identically on every page — that was already Insights' own
deliberate choice (a filtered-but-invisible Created/Updated would make its
age-histogram charts look broken, not useful) and this change preserves it
rather than reopening it.

**No cookie migration.** The `forge-board-filters` cookie's shape changes
from `{pr: {...}, issue: {...}}` to the new shared-plus-two-extras shape.
An old cookie simply won't match what the new reader expects and gets
treated as absent, same as a first-time visitor — no version field, no
migration code. This is a client-side display preference, not data, so a
one-time silent reset to defaults after this ships is an acceptable cost
against writing and later deleting migration code for a cookie shape that
only ever existed pre-release.

## Risks / Trade-offs

- One shared author/repo/label/etc. across both boards means a user can no
  longer filter Issues by one author and Pull Requests by another at the
  same time → Mitigation: this is the explicitly confirmed trade-off (one
  shared meaning per field, over keeping the two boards independent); if it
  proves too restrictive later, per-board overrides could be layered on top
  of this same shared object without another full redesign.
- The filter bar now sits above both boards rather than inside each one, so
  the Issues board (further down the page) is more visually distant from
  the controls that filtered it → Mitigation: keep each board's own visible
  "N of M shown" count, per the proposal, so filtering state stays legible
  without needing to scroll back up to the bar.
- Native-radio segmented control needs its own CSS to avoid looking like
  default browser radio buttons across browsers → Mitigation: well-known,
  low-risk CSS pattern (visually hide the input, style the label); no new
  JS behavior required.

## Migration Plan

Pure frontend static-asset change, no backend, API, or data-layer change —
ships as a normal PR/release. Old persisted cookies age out on first load
post-deploy (see the no-migration decision above) rather than needing a
migration step. Rollback is a normal revert of the frontend files; nothing
server-side to roll back.

## Open Questions

- Exact responsive/mobile layout of the segmented control and shared bar at
  narrow widths (stack vs. horizontal scroll) — a CSS detail that doesn't
  change the shared-state approach, the specs, or the task breakdown, so
  it's left to implementation.
