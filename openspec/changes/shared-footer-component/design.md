# Design

## Context

`footer.js` (`internal/api/static/footer.js`) is a plain DOM-query IIFE,
independently injected via `<script src>` by 9 separate pages —
`login` plus all 8 under `(app)`. Every one of their `<footer>` blocks is
byte-identical markup (confirmed by reading all 9 directly — see
proposal.md); the only thing that varies by page is which self-link
`footer.js` suppresses, computed from `window.location.pathname`. See
proposal.md - Why for the rest of the motivation, including why this is
a smaller lift than `#646` originally scoped it as.

Two duplicate-injection bugs already found and fixed this way — the
dashboard's own (`#648`) and `insights`' own (`#647`) — were both
`footer.js` running twice on one page and doubling the Disclaimer/Privacy
links. This change removes every remaining injection site, so that
whole bug class goes away rather than needing another one-off fix
whenever a page's own duplicate injection is next discovered.

## Goals / Non-Goals

**Goals:**

- One shared `Footer.svelte` component, rendered once per page (by the
  `(app)` layout for 8 pages, by `login` for the 9th) instead of 9
  copies of the same markup plus a DOM-query script.
- No behavior regression: same content, same version display, same
  self-link suppression, on every page that has a footer today.
- Retire `internal/api/static/footer.js` for good — nothing left to load
  it once this lands.

**Non-Goals:**

- Any visual redesign of the footer itself — same content, same order,
  same styling classes (`.mono`, the `·` separators).
- Touching `nav.js`, `(app)/+layout.svelte`'s nav chrome, or the mobile
  bottom tab bar — `#645`'s territory, already shipped.

## Decisions

**A single shared `$lib/Footer.svelte` component, not a per-route-group
copy.** Alternative considered: one footer owned by `(app)/+layout.svelte`
and a second, separate one for `login` (mirroring how nav chrome only
ever lived in the `(app)` layout, never duplicated for `login`, since
`login` has no persistent nav to begin with). Rejected — unlike nav,
`login`'s footer isn't a simplified subset of the shared one, it's
_identical_ down to the byte (confirmed directly): the same mirror
statement, the same version display, the same three self-suppressible
links. A second copy of identical markup and logic is exactly the
duplication this change exists to retire; a real shared component
avoids it in the one place a second injection site could otherwise creep
back in.

**No SSR pitfall here, unlike `#645`'s dashboard-toolbar attempt.** That
approach failed because the _page_ needed to inject content into
something the _layout_ renders earlier in its own template — a
structural child-before-parent ordering problem. This is different: the
Footer component owns all of its own state (the version fetch, the
current-route check for self-link suppression) independently in each
place it's rendered. Nothing crosses a parent/child boundary; each
instance is self-contained, so there's nothing for SSR's top-down
render order to break.

**Self-link suppression reuses `$page.url.pathname`, matching `#645`'s
nav pattern**, rather than porting `footer.js`'s own
`window.location.pathname` check verbatim. Both resolve to the same
value in the browser; using SvelteKit's own reactive current-URL is
already the established idiom in this codebase (`(app)/+layout.svelte`'s
`isCurrentRoute`/`isPublicRoute`), and it's what makes the check
work identically whether the page was reached by a hard load or (in the
`(app)` layout's case) a future client-side navigation.

**Version fetch happens once per `Footer.svelte` instance, in `onMount`
via a plain `fetch`, not a shared store.** The component is mounted once
per page load today (hard navigation between static pages, same as
every other page in this app); nothing yet does client-side navigation
within `(app)` that would make repeated fetches wasteful enough to
justify a cache. Revisit if that changes.

**Dead code order**: delete each page's own `<footer>...</footer>`
markup and `footer.js` injection as the component replaces it, per
page, and delete `internal/api/static/footer.js` itself only in the
last task, once every replacement is confirmed working — so there's
never a page left mid-migration with no footer at all.

## Risks / Trade-offs

- **[Risk]** Missing the exact escaping/markup nuance in one of the 9
  copies (`&middot;` vs `·`, whitespace inside the `.mono` span) could
  make the shared component subtly different from what one particular
  page had. → **Mitigation**: since all 9 were confirmed byte-identical
  before writing this design (not assumed), the component's markup is a
  direct copy of any one of them, not a reconstruction from memory.
- **[Risk]** `footer.js`'s version-unknown behavior (show nothing,
  including no release-history link, until the fetch resolves) is easy
  to get subtly wrong in a rewrite — e.g. showing the release-history
  link immediately instead of gating it on the same fetch resolving.
  → **Mitigation**: spec's "Version unknown" and the release-history
  link's own gating are both explicit requirements/scenarios, not left
  to be inferred from the version display alone.

## Migration Plan

No data migration — client-side chrome only. Rollback is a plain revert;
nothing server-side depends on the new markup. `internal/api/static/
footer.js` deletion is the one irreversible-feeling step, sequenced last
per the Decisions above so a partial revert still has something working.
