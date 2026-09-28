# Proposal

## Why

The persistent header nav (#269/#270) puts five circular icon links plus
the signed-in username and sign-out button in one row. At mobile widths
(confirmed at 390px in a design mockup, alrayyes/forge-dashboard#645) that
row wraps onto a second line, and the nav itself is driven by `nav.js`, a
plain DOM-query IIFE rather than real Svelte state — already flagged as a
known follow-up in `(app)/+layout.svelte`'s own comments. Adding a second
nav surface (a mobile bottom tab bar) is the point where duplicating that
DOM-query pattern a second time stops making sense; it's also the natural
point to finish porting the shared nav chrome to Svelte state so both
surfaces read one source of truth.

`footer.js` was originally scoped into this change alongside `nav.js`, on
the assumption it lived in the same shared layout. It doesn't — it only
populates a `#footer-version` span duplicated by hand across 9 separate
page files, so porting it is its own refactor, not part of a focused nav
change. Split out to alrayyes/forge-dashboard#646.

## What Changes

- Port `nav.js`'s logic (session fetch, `whoami`, admin-link visibility,
  current-page highlight, sign-out) into real Svelte state in
  `web/src/routes/(app)/+layout.svelte`.
- Add a mobile bottom tab bar (Home / Insights / Webhooks / Settings) that
  reads that same session/admin state, shown at narrow viewports.
- Simplify the top header at those same widths once the bottom bar exists.
  Settled in design.md: the header's icon nav stays for desktop/tablet
  widths, and Admin stays header-only rather than a 5th bottom-tab slot.

## Capabilities

### New Capabilities

- `app-navigation`: the signed-in shell's persistent navigation — which
  routes are reachable from the header vs. a mobile bottom tab bar, how the
  current page and admin-only links are indicated, and how sign-out works.
  No existing spec covers this (`openspec list --specs` shows only
  `dashboard-filtering`, `dashboard-force-refresh`, `forge-error-display`,
  `pr-merge-status` — all dashboard-content concerns, not shell chrome).

### Modified Capabilities

None — the four existing specs are unaffected; this only touches
navigation chrome, not their requirements.

## Impact

- `web/src/routes/(app)/+layout.svelte` — nav chrome rewritten as Svelte
  state instead of an injected `<script src>` tag.
- `web/src/routes/+page.svelte` (the dashboard) — moved to
  `web/src/routes/(app)/+page.svelte` so it actually inherits the layout
  above; discovered mid-implementation that it wasn't already part of
  `(app)` despite being a signed-in page, so the new nav chrome never
  reached it. Its own duplicated header/nav markup and `nav.js`
  injection are removed as part of the move (see design.md - Decisions).
- `internal/api/static/nav.js` — not deleted by this change: the
  bare-route-group pages (release history/disclaimer/privacy) still load
  it, and whether they move under `(app)` or keep a separate path is an
  explicit non-goal here (see design.md).
- `internal/api/static/style.css` — new rules for the bottom tab bar,
  reusing existing tokens (`--accent`, `--accent-ink`, `--surface`,
  `--border`) rather than introducing new ones.
- Playwright journey tests exercising these pages — extended with a mobile
  viewport pass and axe-core scan for the new bottom tab bar.
