# Proposal

## Why

The persistent header nav (#269/#270) puts five circular icon links plus
the signed-in username and sign-out button in one row. At mobile widths
(confirmed at 390px in a design mockup, alrayyes/forge-dashboard#645) that
row wraps onto a second line, and the nav itself is driven by `nav.js`/
`footer.js`, plain DOM-query IIFEs rather than real Svelte state — already
flagged as a known follow-up in `(app)/+layout.svelte`'s own comments.
Adding a second nav surface (a mobile bottom tab bar) is the point where
duplicating that DOM-query pattern a third time stops making sense; it's
also the natural point to finish porting the shared chrome to Svelte state
so both surfaces read one source of truth.

## What Changes

- Port `nav.js`'s logic (session fetch, `whoami`, admin-link visibility,
  current-page highlight, sign-out) and `footer.js` into real Svelte state
  in `web/src/routes/(app)/+layout.svelte`.
- Add a mobile bottom tab bar (Home / Insights / Webhooks / Settings) that
  reads that same session/admin state, shown at narrow viewports.
- Simplify the top header at those same widths once the bottom bar exists
  (exact breakpoint behavior and whether Admin gets a bottom-tab slot are
  open questions on the issue, to settle in design.md).

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

- `web/src/routes/(app)/+layout.svelte` — nav/footer chrome rewritten as
  Svelte state instead of injected `<script src>` tags.
- `internal/api/static/nav.js`, `internal/api/static/footer.js` — retired
  once every page consuming them lives under `(app)`; the bare-route-group
  pages (release history/disclaimer/privacy) that also load `nav.js` need a
  decision on whether they move under `(app)` or keep a separate path —
  called out as an open question, not resolved by this change.
- `internal/api/static/style.css` — new rules for the bottom tab bar,
  reusing existing tokens (`--accent`, `--accent-ink`, `--surface`,
  `--border`) rather than introducing new ones.
- Playwright journey tests exercising these pages — extended with a mobile
  viewport pass and axe-core scan for the new bottom tab bar.
