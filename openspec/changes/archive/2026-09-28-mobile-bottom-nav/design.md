# Design

## Context

`(app)/+layout.svelte` currently injects `nav.js` as a real `<script
src>` element in `onMount` (see its own header comment) because Svelte
only allows one top-level `<script>` per component, and that file is a
plain DOM-query IIFE shared, unmodified, by every page under `(app)` —
release history, disclaimer, and privacy included. (An earlier version
of this doc claimed those three lived _outside_ `(app)`, gated only by
`document.body.dataset.pageRequiresAuth` for a nav.js loaded some other
way — that was wrong; they're `(app)/releases`, `(app)/disclaimer`,
`(app)/privacy`, same as every other page here, confirmed after this
change's first pass broke them — see Decisions below.) `nav.js` does
four things:
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

**Discovered mid-implementation, not in the original context above:**
`web/src/routes/+page.svelte` (the dashboard, `/`) is not actually
inside the `(app)` route group, despite being a signed-in page like
every other one that is. It carries its own duplicate of the header/nav
markup and its own separate `nav.js`/`footer.js` injection. Confirmed
live: after porting `(app)/+layout.svelte`, the built
`internal/api/static/insights.html` had the new chrome and
`index.html` (the dashboard) didn't. Folding it into `(app)` is now
part of this change (tasks.md group 2) rather than a silent gap —
see Decisions below for why, over the alternative of duplicating the
new markup into the dashboard's own header instead.

## Goals / Non-Goals

**Goals:**

- One source of truth (Svelte state in `(app)/+layout.svelte`) driving
  both the existing header nav and the new bottom tab bar.
- No behavior regression on desktop: same session fetch, same
  current-page highlighting, same admin-gating, same sign-out flow.

**Non-Goals:**

- Porting `footer.js` — split out to alrayyes/forge-dashboard#646.
- Any visual/content change to the dashboard, insights, webhooks, or
  settings pages beyond the nav chrome itself.

## Decisions

**Fold the dashboard root page into the `(app)` route group rather than
duplicating the new nav markup into its own separate header.** Confirmed
with the user after the gap above was found live. Alternative
considered: leave `+page.svelte` where it is and copy the ported
Svelte-state header and the new bottom tab bar into its own duplicate
markup, same as it already duplicates today's header. Rejected — that
re-introduces the exact duplicated-chrome problem this whole change
exists to retire, just with twice the markup to keep in sync from now
on instead of once. The move itself is mechanical (a route group adds
no URL segment, so `(app)/+page.svelte` still resolves to `/`); the
real cost is deleting the page's own ~200-line duplicate header block
and its `nav.js` injection line, both of which become dead weight the
moment the page inherits `(app)/+layout.svelte`.

**The dashboard's own remaining header content (`#forge-names`,
`#dashboard-owner-select`, `#forge-health`, `.refreshed`/`#refreshed-at`,
`#force-refresh-button` — real, tested, dashboard-only, not duplicated
anywhere else) stays as the page's own plain, non-landmark markup right
after the layout's `<header>`, not merged into that `<header>`.** A
first attempt tried a Svelte context "slot" — the layout exposes a
setter, the page hands it snippets for the layout to render inside its
own `<header>` — and it failed for a structural reason, not a wiring
bug: SvelteKit's SSR renders a layout's own template, including
everything before `{@render children()}`, in one synchronous top-down
pass, before the child page's script runs at all. A child cannot feed
content into something its parent renders earlier in its own source
order — confirmed empirically (the content was verified absent from the
prerendered `internal/api/static/index.html` build output) and by
reading the compiled SSR output directly, not assumed. This holds
regardless of which Svelte primitive moves the data (`$effect`,
top-level script, a store) — it is not an SSR-timing bug to route
around, it is what "parent renders before child runs" means. Even a
version of this that somehow worked would still fail: two `<header>`
elements are two `banner` landmarks, which WAI-ARIA disallows and
axe-core's `landmark-no-duplicate-banner` rule flags as a hard
violation — this spec's own Accessible navigation requirement would
reject it regardless. The actual fix: this content was always static
shell markup (an empty `#forge-health` div, a `hidden`-by-default
`<select>`, populated by the page's own script exactly like `#pr-rows`
or `#stat-prs` already are) — it doesn't need cross-component
composition at all, just its own non-landmark container
(`.dashboard-toolbar` or similar) in the page's own template, styled to
read visually as a continuation of the shared header without being a
second `<header>`.

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

**`releases`/`disclaimer`/`privacy` stay reachable without a session via
a route check in the layout (`isPublicRoute()`, reusing
`isCurrentRoute`'s `.html`-tolerant matching against a
`PUBLIC_ROUTES` list), not the `document.body.dataset.pageRequiresAuth`
flag `nav.js` used to read.** Found live: this layout's ported
session-fetch 401 handler force-redirected all three to `/login.html`
even with no session, because — per the Context correction above —
they're genuinely inside `(app)` and this layout has no per-page
opt-out at all. A DOM-dataset flag set by each page's own `onMount` and
read by this layout's `onMount` has an inherent mount-order race with
no guaranteed winner; a route check needs no cross-component signaling
and no race, since `$page.url.pathname` is already known synchronously
by the layout itself. The now-unread `pageRequiresAuth` flag and its
`browser`-guarded assignment were removed from all three pages as dead
code, confirmed by grepping the tree for any other reader before
deleting it.

Separately: `nav.js` and `footer.js` are still injected independently
by `web/src/routes/(app)/insights/+page.svelte`'s own `onMount`, a
leftover unrelated to this change (present before it started, not
introduced by it) — the same duplicated-injection pattern the
dashboard had before being folded in (tasks.md group 2), just not yet
cleaned up here since insights was never broken by anything this
change touches. Filed as alrayyes/forge-dashboard#647 rather than silently
left as a `TODO`.

## Risks / Trade-offs

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
