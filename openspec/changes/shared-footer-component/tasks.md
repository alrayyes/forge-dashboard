# Tasks

## 1. Build the shared Footer component

- [ ] 1.1 Create `web/src/lib/Footer.svelte`: the exact markup byte-copied from any one of the 9 existing `<footer>` blocks (confirmed identical — design.md's own Risk on this), version display in `$state` populated via an `onMount` fetch to `/api/version` (dev-build label vs. linked version number vs. nothing while unresolved/failed, per design.md - Decisions), and self-link suppression (Disclaimer/Privacy/Release history) derived from `$page.url.pathname`; verify by importing it into one page (pick `(app)/webhooks`, arbitrary) in place of that page's own `<footer>` and confirming the dev server renders it identically to the old markup.
- [ ] 1.2 Add Playwright coverage for the new component's own behavior — version display (released/dev/unresolved), and self-link suppression on each of release history/disclaimer/privacy — extending `tests/legal.spec.js` and/or `tests/releases.spec.js`, whichever already exercises those pages' footers, rather than a new bolt-on file.

## 2. Roll it out to every page

- [ ] 2.1 In `web/src/routes/(app)/+layout.svelte`: render `<Footer />` once, after `{@render children()}`; remove the `/footer.js` line from its own `onMount` script-injection (keep everything else in that block); verify the built output for every `(app)` page still has the mirror statement, version display, and correct self-link suppression per page.
- [ ] 2.2 In `web/src/routes/login/+page.svelte`: render `<Footer />` directly, remove its own `<footer>` markup and `/footer.js` injection; verify the built login page's footer matches every other page's.
- [ ] 2.3 Delete the duplicated `<footer>...</footer>` markup from each of the 8 `(app)` pages that still has its own copy (dashboard, insights, webhooks, settings, admin, releases, disclaimer, privacy) now that `(app)/+layout.svelte` provides it; verify each page's built output has exactly one `<footer>` element.
- [ ] 2.4 Run the full existing Playwright suite and confirm no regression beyond the footer markup's own location in the DOM (id/class/text content all unchanged).

## 3. Retire footer.js

- [ ] 3.1 Confirm nothing in `web/src/` references `/footer.js` any more (grep the tree); delete `internal/api/static/footer.js`.
- [ ] 3.2 Update README.md/CONTRIBUTING.md if either still describes `footer.js` as part of the shared chrome (CONTRIBUTING.md's `(app)` route-group paragraph, last touched in `#645`, is the likely spot); verify by re-reading the relevant section against the shipped state.

## 4. Wrap-up

- [ ] 4.1 Open the pull request with `Closes #646`, noting the component-reuse decision (one `Footer.svelte`, not a per-route-group copy) in the description; verify CI is green before requesting merge.
