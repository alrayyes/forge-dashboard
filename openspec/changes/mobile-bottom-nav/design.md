# Design

## Context

`(app)/+layout.svelte` currently injects `nav.js` as a real `<script
src>` element in `onMount` (see its own header comment) because Svelte
only allows one top-level `<script>` per component, and that file is a
plain DOM-query IIFE shared, unmodified, by every page under `(app)`
plus three unauthenticated pages outside it (release history,
disclaimer, privacy — `nav.js`'s own header comment names them, gated by
`document.body.dataset.pageRequiresAuth`). `nav.js` does four things:
highlights the current-page link via `aria-current`, fetches
`/api/auth/session` to show `whoami` and toggle `#admin-link[hidden]`,
and wires `#logout-button`'s click handler. `footer.js` is out of scope
here — see proposal.md - Why for why it was split out to
alrayyes/forge-dashboard#646. See proposal.md - Why for the rest of the
motivation.

Existing coverage in `tests/nav.spec.js` (#269) asserts against
`a[aria-label="<Page>"]` locators unscoped by container, on the
assumption there's exactly one nav landmark. Adding a second nav surface
with the same labels breaks that assumption — see Decisions below.

## Goals / Non-Goals

**Goals:**

- One source of truth (Svelte state in `(app)/+layout.svelte`) driving
  both the existing header nav and the new bottom tab bar.
- No behavior regression on desktop: same session fetch, same
  current-page highlighting, same admin-gating, same sign-out flow.

**Non-Goals:**

- Re-homing the three unauthenticated pages (release history, disclaimer,
  privacy) under `(app)`, or giving them their own Svelte-state nav copy —
  they keep loading `nav.js` as-is until a separate change decides how
  they fit. `nav.js` is retired only once nothing left in the tree loads
  it; until then it stays, dead code for the `(app)` pages but still
  load-bearing for those three.
- Porting `footer.js` — split out to alrayyes/forge-dashboard#646.
- Any visual/content change to the dashboard, insights, webhooks, or
  settings pages beyond the nav chrome itself.

## Decisions

**Bottom tab bar only replaces the header nav below the mobile
breakpoint; both surfaces share one Svelte state module.** Confirmed with
the user over the two questions left open on
alrayyes/forge-dashboard#645:

- The header keeps its icon nav at desktop/tablet widths; the bottom tab
  bar takes over only below the mobile breakpoint (matching the approved
  mockup, https://claude.ai/artifact/KH64Wdp5CrZyBSKejJx7y1).
- The bottom tab bar is fixed at 4 tabs (Home/Insights/Webhooks/Settings)
  for every session; Admin stays header/desktop-only, not a 5th
  conditional tab.

  Breakpoint: reuse whatever width `style.css`'s existing `@media
(max-width: …)` rules already treat as "mobile" for this layout (the
  file has rules at 860px/760px/420px/480px — pick whichever one already
  governs header wrapping, rather than inventing a new breakpoint) so the
  bottom bar's threshold lines up with where the header actually starts
  crowding, not an arbitrary new number.

**Session/admin/current-page state lives in `(app)/+layout.svelte` as
Svelte state (`$state` + `onMount` fetch), not a store.** Both nav
surfaces render from the same layout component, so component-local state
passed as props to a `BottomNav` (or inlined) child is sufficient — no
cross-component sharing that would justify a Svelte store or context.
Alternative considered: a `$lib` store so a future page outside this
layout could read session state too. Rejected for now — nothing today
needs it outside this one layout, and it's a small change to add a store
later if that need appears (proposal's Non-Goals already excludes the
unauthenticated pages from this change).

**Current-page detection uses SvelteKit's own `$page.url.pathname`
instead of porting `nav.js`'s manual
`a.pathname === window.location.pathname` query.** SvelteKit already
tracks the active route reactively; querying the DOM for `.app-nav a`
elements was only ever necessary because `nav.js` had no framework
context. Both the header links and the bottom tab bar derive their
`aria-current` from the same reactive comparison.

**Sign-out and session-fetch logic are ported verbatim in behavior**
(same endpoints, same redirect target `/login.html`), just moved from
`fetch(...).then(...)` chains triggered by DOM events into Svelte
`onMount`/event-handler equivalents. No API contract changes.

**The header nav and the bottom tab bar are two distinct `<nav>`
landmarks with matching `aria-label`s per link but no shared DOM, and
existing tests scope to a container rather than relying on a single
sitewide match.** Both surfaces reuse the same link labels ("Home",
"Insights", "Webhooks", "Settings") for a consistent accessible name per
destination, but that means `page.locator('a[aria-label="Home"]')`
resolves to two elements once both surfaces exist in the DOM (one CSS-
hidden depending on viewport) — a Playwright strict-mode violation.
`tests/nav.spec.js`'s existing `NAV_PAGES` assertions get scoped to the
header's own container (e.g. `header a[aria-label="Home"]`), and new
bottom-tab-bar assertions scope to its own `<nav aria-label="Mobile
navigation">` landmark. Alternative considered: only mount the inactive
surface's DOM conditionally (`{#if isMobile}`) instead of hiding it with
CSS, so exactly one always exists. Rejected — that needs a
`matchMedia`/resize listener and reintroduces a flash-of-missing-nav on
first paint that pure CSS avoids; scoping the locators is a smaller,
one-time cost against tests that already exist.

## Risks / Trade-offs

- **[Risk]** The three unauthenticated pages still load `nav.js`, so the
  codebase carries two parallel nav implementations (vanilla for those
  three, Svelte for everything under `(app)`) until a follow-up change
  addresses them. → **Mitigation**: called out explicitly as a Non-Goal
  here and as an out-of-scope item on the issue, not silently dropped;
  `nav.js` stays in the tree (not deleted) until nothing loads it.
- **[Risk]** Reusing an existing `style.css` breakpoint for the bottom
  bar couples this change to whichever rule is chosen; if that rule's
  purpose shifts later (e.g. the header itself gets restyled), the bottom
  bar's trigger point moves with it unintentionally. → **Mitigation**:
  name the specific breakpoint chosen in a code comment at the point of
  use, same pattern the rest of `style.css` already follows for its own
  non-obvious values.
- **[Risk]** Porting `nav.js`'s admin-visibility check from `hidden`
  attribute toggling to conditional Svelte rendering changes _how_ the
  DOM hides the Admin link (removed vs. `display: none`), which could
  interact differently with the axe-core scan or existing CSS selectors
  targeting `[hidden]`. → **Mitigation**: spec's Accessible navigation
  requirement covers this with a scan assertion; tasks.md includes
  re-running the scan before considering this done.

## Migration Plan

No data migration — this is client-side chrome only, shipped behind the
normal PR/CI/review flow. Rollback is a plain revert; nothing server-side
depends on the new markup.
