# Tasks

## 1. Port nav chrome to Svelte state

- [ ] 1.1 Add Svelte state (`$state`) in `(app)/+layout.svelte` for session (`displayName`, `isAdmin`) populated via `onMount` fetch to `/api/auth/session`, replacing `nav.js`'s fetch; verify by running the existing dashboard/insights/webhooks/settings Playwright journey tests unmodified and confirming they still pass.
- [ ] 1.2 Replace `nav.js`'s DOM-query current-page highlighting with a value derived from SvelteKit's `$page.url.pathname`, applied via `aria-current="page"` in the header nav markup; verify with a Playwright assertion (added to the existing journey tests) that each header link shows `aria-current="page"` only on its own route.
- [ ] 1.3 Replace `#admin-link.hidden` toggling with conditional rendering (`{#if session.isAdmin}`) around the header's Admin link; verify with a Playwright test asserting the Admin link is absent for a non-admin session and present for an admin session.
- [ ] 1.4 Port sign-out (`fetch('/api/auth/logout', {method:'POST'})` then redirect to `/login.html`) onto a Svelte click handler on the existing sign-out button; verify with a Playwright test that activating sign-out ends the session and lands on `/login.html`.
- [ ] 1.5 Remove the `onMount` script-injection block for `nav.js` from `(app)/+layout.svelte` now that every page under `(app)` gets its nav chrome from Svelte state; verify by confirming no `(app)` page's rendered output requests `/nav.js`.
- [ ] 1.6 Rescope `tests/nav.spec.js`'s existing `NAV_PAGES` locators (`a[aria-label="..."]`) to the header's own container (design.md - Decisions: two `<nav>` landmarks will share link labels once the bottom tab bar exists), so they keep resolving to exactly one element; verify the full existing `nav.spec.js` suite still passes unmodified in behavior, only in locator scope.

## 2. Fold the dashboard root page into `(app)`

Discovered mid-implementation: `web/src/routes/+page.svelte` (the
dashboard, `/`) isn't actually inside the `(app)` route group despite
being a signed-in page — it carries its own ~200-line duplicate of the
header/nav markup and its own separate `nav.js`/`footer.js` injection,
so tasks 1.1-1.6 and 2.1-2.3 below don't reach it as written. Confirmed
live: after implementing group 1, the built `internal/api/static/
insights.html` had the ported nav chrome and `insights.html` had no
bottom-nav markup, `index.html` (the dashboard) had none.

- [ ] 2.1 Move `web/src/routes/+page.svelte` to `web/src/routes/(app)/+page.svelte` (`git mv`, preserving history); verify the dev server still resolves `/` to this page with no routing error (route groups don't add a URL segment, so this doesn't change the page's own path).
- [ ] 2.2 Remove the page's own duplicated `.app-nav`/`#admin-link`/`#logout-button`/brand-logo markup now that it inherits `(app)/+layout.svelte`'s; keep the page's own genuinely-unique content (`#forge-names`, `#dashboard-owner-select`, `#forge-health`, `.refreshed`/`#refreshed-at`, `#force-refresh-button`) as the page's own plain non-landmark markup rather than merging it into the layout's `<header>` (design.md - Decisions: a context-based merge was tried and failed for a structural SSR reason, not a wiring bug — two `<header>` landmarks also fails the Accessible navigation requirement's axe-core scan on its own). Verify the built `internal/api/static/index.html` contains exactly one `<header>` and one `.app-nav`, and that `forge-names`/`dashboard-owner-select`/`forge-health`/`refreshed-at`/`force-refresh-button` are all present in that same built output (not just in dev/hydrated behavior).
- [ ] 2.3 Remove `nav.js` from this page's own `onMount` script-injection array (mirroring 1.5), leaving `footer.js`'s injection untouched (still out of scope, `#646`); verify the built dashboard's rendered output no longer requests `/nav.js`.
- [ ] 2.4 Run the existing `tests/dashboard.spec.js` journey test and confirm it still passes with no behavior regression beyond the nav chrome itself (stats, filters, PR/issue list all unchanged).

## 3. Add the mobile bottom tab bar

- [ ] 3.1 Add the bottom tab bar markup (Home/Insights/Webhooks/Settings) to `(app)/+layout.svelte`, in its own `<nav aria-label="Mobile navigation">` landmark, `<a href>` values matching the header nav's own `.html` targets (`/`, `/insights.html`, `/webhooks.html`, `/settings.html` — no bare-path routes exist server-side), styled in `internal/api/static/style.css` reusing existing tokens (`--accent`, `--accent-ink`, `--surface`, `--border`), shown only below the breakpoint chosen in design.md - Decisions (named in a code comment at the point of use); verify by loading a page at a mobile viewport in the dev server and confirming the bar renders with all 4 tabs.
- [ ] 3.2 Wire the bottom tab bar's current-tab indicator to the same `$page.url.pathname`-derived state as the header nav (1.2), so exactly one control (scoped by its own landmark, per 1.6) shows `aria-current="page"` at a time; verify with a Playwright test at a mobile viewport asserting the active tab matches the current route and no other tab is marked current.
- [ ] 3.3 Confirm the header's icon nav is removed from the tab order (not just visually collapsed) below the breakpoint, and the bottom tab bar is likewise removed from the tab order above it; verify by checking computed style and keyboard tab order at both a desktop and mobile viewport.

## 4. Accessibility and cross-page coverage

- [ ] 4.1 Extend the dashboard, insights, webhooks, and settings Playwright journey tests with a mobile-viewport pass including an axe-core scan (`a11y.md`) with the bottom tab bar visible; verify `results.violations` is empty on every page.
- [ ] 4.2 Verify keyboard reachability of every bottom tab bar control (Tab reaches it, Enter/Space activates it, focus outline visible) via a Playwright keyboard-navigation assertion.

## 5. Wrap-up

- [ ] 5.1 Update README.md if its description of the nav migration status (referencing #326) needs a note that `(app)`'s own nav chrome — now including the dashboard — no longer depends on `nav.js`, while the three unauthenticated pages still do; verify by re-reading the relevant README section against the shipped state.
- [ ] 5.2 Open the pull request with `Closes #645`, stating the breakpoint, Admin-tab, and dashboard-relocation decisions in the description; verify CI is green before requesting merge.
