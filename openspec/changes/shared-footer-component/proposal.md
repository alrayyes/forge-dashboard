# Proposal

## Why

`footer.js` is a plain DOM-query IIFE, independently injected by all 9
pages that have a footer (`login` plus every page under `(app)`) — the
same duplication pattern `#645` already retired for the nav. Confirmed
by reading every page's own `<footer>` markup directly
(alrayyes/forge-dashboard#646): it's byte-identical across all 9, and
`footer.js`'s own logic (version display, self-link suppression for
Disclaimer/Privacy/Release history) is purely a function of the current
route, with no other per-page variance at all. That's a much smaller
lift than #646 originally scoped it as ("extract a Footer.svelte
component and thread it through 9 files") — there's no page-specific
content to reconcile the way the dashboard's own toolbar needed in
#645, so this carries none of that change's SSR pitfalls.

## What Changes

- A single `$lib/Footer.svelte` component replaces the duplicated
  `<footer>` markup and `footer.js` injection everywhere: rendered once
  by `web/src/routes/(app)/+layout.svelte` for all 8 pages under it, and
  once directly by `web/src/routes/login/+page.svelte`, the one page
  outside that group.
- Version display and self-link suppression (Disclaimer/Privacy/Release
  history, each hidden on its own page) become real Svelte state instead
  of DOM `appendChild` calls, reusing the same `$page.url.pathname`
  route-matching pattern `#645` already established for nav.
- `internal/api/static/footer.js` retired once nothing loads it —
  confirmed nothing will: this change removes every remaining injection
  site (`(app)/+layout.svelte`'s own, and `login/+page.svelte`'s own;
  `web/src/routes/(app)/insights/+page.svelte`'s redundant second
  injection was already removed in `#647`).

## Capabilities

### New Capabilities

- `app-footer`: the signed-in shell's and login page's shared footer —
  what it shows (mirror/credentials statement, source link, version),
  and which self-referential links are suppressed on their own page.
  No existing spec covers this (`openspec list --specs` shows
  `app-navigation`, `dashboard-filtering`, `dashboard-force-refresh`,
  `forge-error-display`, `pr-merge-status` — none are footer content).

### Modified Capabilities

None.

## Impact

- `web/src/lib/Footer.svelte` — new shared component.
- `web/src/routes/(app)/+layout.svelte` — renders `<Footer />` once,
  after `{@render children()}`; its own `onMount` no longer injects
  `/footer.js`.
- `web/src/routes/login/+page.svelte` — renders `<Footer />` directly;
  its own `onMount` no longer injects `/footer.js`.
- The 8 `(app)` pages that currently each carry their own duplicated
  `<footer>...</footer>` markup — deleted from all 8 (dashboard,
  insights, webhooks, settings, admin, releases, disclaimer, privacy).
- `internal/api/static/footer.js` — deleted once every injection site
  above is gone.
- Playwright coverage exercising the footer (currently indirect, via
  `tests/legal.spec.js`'s "footer links to both from another page, but
  not from themselves" and the per-page journey tests' own incidental
  footer checks, if any) — extended with direct coverage of the new
  component's behavior.
