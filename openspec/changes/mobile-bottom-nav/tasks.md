# Tasks

## 1. Port nav/footer chrome to Svelte state

- [ ] 1.1 Add Svelte state (`$state`) in `(app)/+layout.svelte` for session (`displayName`, `isAdmin`) populated via `onMount` fetch to `/api/auth/session`, replacing `nav.js`'s fetch; verify by running the existing dashboard/insights/webhooks/settings Playwright journey tests unmodified and confirming they still pass.
- [ ] 1.2 Replace `nav.js`'s DOM-query current-page highlighting with a value derived from SvelteKit's `$page.url.pathname`, applied via `aria-current="page"` in the header nav markup; verify with a Playwright assertion (added to the existing journey tests) that each header link shows `aria-current="page"` only on its own route.
- [ ] 1.3 Replace `#admin-link.hidden` toggling with conditional rendering (`{#if session.isAdmin}`) around the header's Admin link; verify with a Playwright test asserting the Admin link is absent for a non-admin session and present for an admin session.
- [ ] 1.4 Port sign-out (`fetch('/api/auth/logout', {method:'POST'})` then redirect to `/login`) onto a Svelte click handler on the existing sign-out button; verify with a Playwright test that activating sign-out ends the session and lands on `/login`.
- [ ] 1.5 Remove the `onMount` script-injection block for `nav.js`/`footer.js` from `(app)/+layout.svelte` now that every page under `(app)` gets its chrome from Svelte state; verify by confirming no `(app)` page's rendered output requests `/nav.js` or `/footer.js`.

## 2. Add the mobile bottom tab bar

- [ ] 2.1 Add the bottom tab bar markup (Home/Insights/Webhooks/Settings) to `(app)/+layout.svelte`, styled in `internal/api/static/style.css` reusing existing tokens (`--accent`, `--accent-ink`, `--surface`, `--border`), shown only below the breakpoint chosen in design.md - Decisions (named in a code comment at the point of use); verify by loading a page at a mobile viewport in the dev server and confirming the bar renders with all 4 tabs.
- [ ] 2.2 Wire the bottom tab bar's current-tab indicator to the same `$page.url.pathname`-derived state as the header nav (1.2), so exactly one control shows `aria-current="page"` at a time; verify with a Playwright test at a mobile viewport asserting the active tab matches the current route and no other tab is marked current.
- [ ] 2.3 Confirm the header's icon nav is removed from the tab order (not just visually collapsed) below the breakpoint, and the bottom tab bar is likewise removed from the tab order above it; verify by checking computed style and keyboard tab order at both a desktop and mobile viewport.

## 3. Accessibility and cross-page coverage

- [ ] 3.1 Extend the dashboard, insights, webhooks, and settings Playwright journey tests with a mobile-viewport pass including an axe-core scan (`a11y.md`) with the bottom tab bar visible; verify `results.violations` is empty on every page.
- [ ] 3.2 Verify keyboard reachability of every bottom tab bar control (Tab reaches it, Enter/Space activates it, focus outline visible) via a Playwright keyboard-navigation assertion.

## 4. Wrap-up

- [ ] 4.1 Update README.md if its description of the nav/footer migration status (referencing #326) needs a note that `(app)`'s own chrome no longer depends on `nav.js`/`footer.js`, while the three unauthenticated pages still do; verify by re-reading the relevant README section against the shipped state.
- [ ] 4.2 Open the pull request with `Closes #645`, stating the breakpoint and Admin-tab decisions from design.md in the description; verify CI is green before requesting merge.
