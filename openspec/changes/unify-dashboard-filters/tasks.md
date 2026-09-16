## 1. Shared filter module

- [x] 1.1 Create `internal/api/static/filters.js` exposing the cookie read/write, `matchesFilters`, and populate-select-preserving-selection helpers currently duplicated between `app.js` and `insights.js`, as plain global functions (no ES module) and verify `bun run lint:js` passes on the new file.
- [x] 1.2 Load `filters.js` via `<script src="filters.js">` in both `index.html` (before `app.js`) and `insights.html` (before `insights.js`) and verify both pages still load with no console error.

## 2. Main dashboard: shared filter bar and segmented forge control

- [x] 2.1 Replace the per-board forge `<select>` in `index.html` with one page-level segmented control (a `<fieldset>` of `<input type="radio" name="forge">` + styled `<label>`s) and style it in `style.css`; verify the current forge selection is visible at rest without opening anything.
- [x] 2.2 Restructure `index.html` to move repo, label, author, title, created, updated, and group-by out of the two per-board rows into one shared top-level filter bar above both boards, keeping CI status attached to the Pull Requests board's own header and "Hide Dependency Dashboard" attached to the Issues board's own header.
- [x] 2.3 In `app.js`, replace the two independent `state.filters` objects with one shared filter object (plus the two board-owned extra fields, PR status and Hide Dependency Dashboard) driving both `createBoard` instances through the shared `filters.js` helpers; verify setting a shared field (e.g. author) filters both boards together, and that CI status / Hide Dependency Dashboard each affect only their own board.
- [x] 2.4 Confirm each board's existing shown/total count badge still reflects the shared filter state after the restructuring.

## 3. Insights page: adopt the shared bar

- [x] 3.1 Replace Insights' own repo/label/author/title controls and its `data-filter-scope="pr"`/`"issue"` split in `insights.html` with the same shared filter bar markup used on the main dashboard for those fields (no group-by — Insights renders charts, not a groupable row list, so it never had or needs that control).
- [x] 3.2 In `insights.js`, remove the duplicated cookie/`matchesFilters`/populate-select logic in favor of the shared `filters.js` helpers, keeping the existing masking so created, updated, and CI-status values are never applied to or displayed on Insights charts.
- [x] 3.3 Verify manually that a filter set on the main dashboard (e.g. author) is reflected on Insights without re-entering it, and that a created/updated/status value left in the cookie by the dashboard has no visible effect on Insights.

## 4. Update existing Playwright coverage

- [x] 4.1 Update `tests/dashboard.spec.js`'s forge-filter tests, which currently drive the old `<select>` with `page.selectOption(... '.col-filter[data-col="forge"]', ...)`, to interact with the new segmented control instead; verify with `bunx playwright test tests/dashboard.spec.js`.
- [x] 4.2 Rewrite `tests/dashboard.spec.js`'s `'the two boards persist their filters independently'` test: under the new design the shared fields (forge, repo, label, author, title, created, updated, group-by) persist and apply jointly across both boards, while only CI status and Hide Dependency Dashboard remain independent per board; verify with the same Playwright run.
- [x] 4.3 Update `tests/insights.spec.js`'s `[data-filter-scope="pr"/"issue"]`-based tests to match the single shared bar for the fields it now shares with the dashboard, keeping its existing assertion that a status/created/updated value left in the cookie has no effect on Insights; verify with `bunx playwright test tests/insights.spec.js`.
- [x] 4.4 Run the full suite (`bunx playwright test` and `bun run lint:js`) across all touched files and fix any regression before considering the change done.
