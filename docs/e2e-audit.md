# E2E audit: which specs could run below the browser

Read-only audit of every `tests/*.spec.ts` (309 files, 2,738 tests) against
`main`. No spec was edited, moved, or deleted. The per-spec table is
[`e2e-audit/spec-classes.csv`](e2e-audit/spec-classes.csv).
[`e2e-audit/classify.py`](e2e-audit/classify.py) regenerates it.

## Regenerating the table

The CSV is output, never edited by hand. From the repository root:

```sh
python3 docs/e2e-audit/classify.py . docs/e2e-audit/spec-classes.csv
```

The script reads `tests/*.spec.ts`, `tests/e2e-durations.json`, the unit tests
in `web/src/lib` and the Go tests under `internal/`. Change a spec, a duration
or one of those tests and the CSV is out of date. `scripts/e2e-audit-csv.test.ts`
reruns the script and fails on any difference, in `bun run test:unit` and so in
the pre-push hook and CI, so the next slice regenerates the table in the same
pull request that changes the spec. Regenerate again after rebasing onto a
`main` that changed specs: two pull requests that each regenerate can both pass
and still leave `main` red until the next regeneration.

The one input a scan cannot find is a lower test proven red by hand, such as a
story. List it in
[`e2e-audit/lower-annotations.json`](e2e-audit/lower-annotations.json) under the
spec's file name and it appears in the `lower` column.

## Method

- Duration is the per-spec figure in `tests/e2e-durations.json`, in seconds. It
  sums to about 1,543 s over 257 specs. Forty-six specs have no recorded
  duration and count as 0; the CSV leaves the cell empty.
- Classes: **A** browser-only (layout, CSS, focus, keyboard, axe, viewport);
  **B** UI over logic a Go test covers; **C** UI over wording or state a unit or
  component test could cover; **D** fully covered below. A spec takes A when
  half or more of its tests use a browser-only API, or when listed by hand
  (`mono-figures`). The rest default to C. B is a hand-picked list of three specs,
  and D is set by hand from the two deleted specs, since neither is detected.
  Mixed specs get their dominant class.
- The token scan only sees assertions written in the spec body. Browser
  assertions held in a helper are missed, so such a spec reads as C when it is
  A. `mono-figures` is the known case and is set to A by hand; others may exist.
- "Est. movable" is an upper bound: spec duration times the share of its tests
  with no browser-only token. Time is assumed proportional to test count. It is
  not a measured saving.
- Most specs mock `/api/v1/dashboard` with `page.route`, so they check the UI
  over canned state. `web/` has 152 unit test files, all in `web/src/lib` (pure
  functions or fake DOM; `bun run test:unit` fails when this count drifts), and
  no Svelte component harness. Class C is therefore blocked on one, tracked as
  its own ticket, except where a lib function already carries the logic.
- A class D claim needs a mutation of the code under test that turns the lower
  test red. Name matching alone never earns D.

## Result

| Class                           | Specs | Summed duration |
| ------------------------------- | ----- | --------------- |
| A browser-only                  | 156   | 733 s           |
| B Go covers the logic           | 3     | 12 s            |
| C needs a lib or component test | 144   | 798 s           |
| D fully covered below           | 0     | 0 s             |

D is empty today. The two specs that qualified (`filter-save-order`,
`filter-mixed-case`) were deleted earlier with their own mutation proof. The
upper bound over classes B and C is about 596 s of the 1,543 s run, and almost
none of it is safe to cut until the lower test exists. The order that keeps
coverage is: write the lower test, prove it red under a mutation, then trim the
spec.

## Evidence per spec group

### Partly covered below (mutation run for this audit)

Each mutation was applied to the code under test, the named lower test file was
run, and the change was reverted.

| Spec                    | Lower test                            | Mutation                                                     | Result      |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------ | ----------- |
| `first-refresh-loading` | `web/src/lib/first-refresh.test.ts`   | `firstRefreshLoading` returns false before the first settle  | 1 fail, red |
| `rerun-all`             | `web/src/lib/rerun-all.test.ts`       | `showRerunAll` returns false while busy                      | 2 fail, red |
| `cancel-run`            | `web/src/lib/cancel-run.test.ts`      | `cancelText` bare label changed                              | 1 fail, red |
| `settings-groups`       | `web/src/lib/settings-groups.test.ts` | `groupFromHash` fallback returns an anchor and the direct id | 1 fail, red |
| `wait-chip`             | `web/src/lib/wait-chip.test.ts`       | `settlesOnRow` stops listing `bot-rebase`                    | 1 fail, red |

The lower tests are sensitive to the logic they cover. Each spec
keeps its layout, keyboard, axe and state-machine tests, so none becomes class
D; only the tests that restate the same wording or predicate can go. The
`wait-chip` lower test pins `settlesOnRow`: dropping any of
the three kinds, or adding `merge`, turns it red. The only spec tests that
restated its wording were the two that read a green GitHub and a green Forgejo
auto-merge chip; they are gone, and changing either branch of `autoMergeChip`
turns two lib tests red.

### UI over logic Go covers (class B)

Six specs started here: `webhooks`, `settings-field-errors`,
`filter-persistence`, `main-branches-server-copy`, `filter-late-copy` and
`filter-newer-wins`. Each Go test below was run red under a mutation of the
server code it covers, and the change was reverted.

`filter-late-copy` has since gone. Each control now calls a function in
`web/src/lib/filter-wiring.ts`, and its unit test goes red when the call that
marks the key as touched is removed.

| Server logic                                                                           | Go test                                                                                                 | Mutation                                                                   | Result            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------- |
| Webhook signature check                                                                | `TestGitHubWebhook_*_Refused`, `TestForgejoWebhook_*_Refused`                                           | check skipped                                                              | 6 fail, red       |
| Webhook names a repo, so only that repo is refreshed                                   | `TestGitHubWebhook_PayloadNamesARepo_TriggersOnlyAScopedRefresh`                                        | scoped path never taken                                                    | 1 fail, red       |
| Webhook triggers a refresh                                                             | `TestGitHubWebhook_ValidSignature_TriggersRefreshAndReturns204`, `TestForgejoWebhook_*_TriggersRefresh` | `RefreshNow` not called                                                    | 5 fail, red       |
| Refresh reaches the open stream                                                        | `TestDashboardStream_PushesASnapshotWhenAWebhookTriggersARefresh`                                       | stream ends before writing the snapshot                                    | 1 fail, red       |
| An unreachable forge stays in the snapshot                                             | `TestAggregator_Refresh_OneSourceUnreachable_OthersStillReported`                                       | unreachable health dropped                                                 | 1 fail, red       |
| A scoped refresh adds the new issue, keeps the repo's others, leaves other repos alone | `TestAggregator_RefreshRepo_ANewIssueJoinsTheReposOwnAndLeavesOtherReposAlone` (new)                    | new issues not merged; old ones also kept; other repos dropped             | 1 fail each, red  |
| Forgejo issue rows carry title, link, and repo                                         | `TestListOpenIssues_UsesTypeIssuesFilter` (asserts widened)                                             | title dropped; link dropped                                                | 1 fail each, red  |
| A refused Forgejo URL names `forgejoUrl`                                               | `TestSettingsPut_ForgejoURL_RefusesCredentialsAndOddURLsNamingTheField` (message asserted)              | ftp scheme allowed; field name left out of the message                     | 1 fail each, red  |
| An over-long field names itself in the message                                         | `TestRequestFields_AStringOverItsBoundIsRefusedWithAFieldError` (message asserted)                      | message loses the name; username bound dropped; rebase label bound dropped | 1 fail each, red  |
| Filter state round-trips                                                               | `TestFilterStatePut_ThenGet_RoundTrips` and the rest of `TestFilterState*`                              | save not stored; read answers `{}`                                         | 7 and 6 fail, red |
| A pick over the limits is refused                                                      | `TestFilterStatePut_Pick`                                                                               | validation off                                                             | 1 fail, red       |
| An older revision does not replace a newer saved copy                                  | `TestFilterStatePut_OlderRevisionThanSaved_*`                                                           | every revision accepted                                                    | 2 fail, red       |
| The page keeps a newer cookie over an older copy                                       | `web/src/lib/filters-newer-wins.test.ts`                                                                | cookie-newer rule dropped                                                  | 1 fail, red       |

`webhooks` (both tests) and `filter-newer-wins` are fully covered by the table and,
for the banner wording, by the existing banner tests. Both were deleted.
Together they ran 4.3 s.

The other four specs remain. Their server side is a store that keeps the filter
state as written, covered in the table, and what each test asserts is the page's
own behaviour: the cookie against the copy, a pick kept through a detour, an
edit that beats a copy still loading, the error wired to its field. A server
mutation does not turn those red, and no lower test pins them yet. They keep
class B in the CSV until one does.

### UI over state a component test could cover (class C)

144 specs, 798 s. No lower test exists for most. Where a lib test partly matches
(`dashboard`, `settings`, `webhooks-filter-choices`), the CSV names it.
Confidence is low wherever no lower test was found.

### Browser-only (class A)

156 specs, 733 s. These stay. Some still carry state-only tests beside the
layout ones; the upper bound counts those.

## Specs worth moving first

Ranked by estimated movable seconds, class A excluded. The figures come from the
CSV, so the table is the state at its last regeneration.

| #   | Spec                        | Duration | Tests | Browser-only | Est. movable | Lower test, or the missing one                          |
| --- | --------------------------- | -------- | ----- | ------------ | ------------ | ------------------------------------------------------- |
| 1   | `dashboard`                 | 38.8 s   | 100   | 15           | 33.0 s       | `dashboard-read` partly; missing: row and state tests   |
| 2   | `cancel-run`                | 24.5 s   | 22    | 7            | 16.7 s       | `cancel-run.test.ts` (proven); missing: dialog wording  |
| 3   | `settings`                  | 21.5 s   | 49    | 11           | 16.7 s       | Go settings tests for server rules; missing: form state |
| 4   | `settings-groups`           | 27.7 s   | 22    | 10           | 15.1 s       | `settings-groups.test.ts` (proven, hash routing only)   |
| 5   | `webhooks-page`             | 17.4 s   | 58    | 8            | 15.0 s       | Missing: page state tests                               |
| 6   | `main-branches-page`        | 24.9 s   | 41    | 19           | 13.4 s       | `main-branch-snapshot-runs` partly; missing: page state |
| 7   | `wait-chip`                 | 19.6 s   | 19    | 6            | 13.4 s       | `wait-chip.test.ts` (proven)                            |
| 8   | `copy-failure`              | 15.0 s   | 16    | 3            | 12.2 s       | `CopyDetails` stories (proven); missing: row wiring     |
| 9   | `label-multi-select`        | 14.1 s   | 26    | 5            | 11.4 s       | Missing: selection state                                |
| 10  | `pull-request-checks`       | 18.1 s   | 41    | 15           | 11.4 s       | Missing: checks list state                              |
| 11  | `repo-author-multi-select`  | 14.6 s   | 24    | 6            | 11.0 s       | Missing: selection state                                |
| 12  | `changelog`                 | 17.5 s   | 20    | 9            | 9.6 s        | `changelog-notes.test.ts` partly; missing: page state   |
| 13  | `first-refresh-first-paint` | 10.0 s   | 15    | 2            | 8.7 s        | `first-refresh.test.ts` (proven); missing: banner state |
| 14  | `pr-dialog-actions`         | 15.7 s   | 30    | 14           | 8.4 s        | Missing: actions enabled                                |
| 15  | `queued-action-feedback`    | 11.9 s   | 13    | 4            | 8.3 s        | Missing: feedback state                                 |

`filter-every-control` is a real navigation and cookie journey, and the token
scan cannot see that. It loops four read-backs over every control. Fewer rounds,
with the server round-trip in a Go test and cookie serialisation in a lib test,
would have cut most of its 29.8 s. It has since been cut to about 8 s; see the
follow-ups.

## Follow-ups

One ticket per group, each doing moves with its own mutation proof:

- Component test harness, so class C has somewhere to go. Done. Storybook
  `play` functions run in Chromium under Vitest (`bun run test:components`,
  see [the catalogue](storybook.md)). The first
  move was three `nav-branches-pills` tests (the pill markup, the approval
  count, a zero not drawn): about 0.80 s of e2e test time became about 0.15 s
  of story time, and removing `aria-hidden` from the pill turns the story red.
  The table above is the state before that move; the CSV row for
  `nav-branches-pills` is updated.
- The second move, from `first-refresh-loading`: four tests that checked the
  status line's wording and live region and the nav pills' dash and plain link
  name. They are now `play` functions on the `FirstRefreshStatus` and `NavPills`
  stories (the ten-second wording, the empty line present before it has text
  and then changing in place, the dash hidden from assistive tech). About 0.65 s
  of e2e test time became about 0.03 s of story time. Each assertion was proven
  red by breaking the component: the slow wording, the loading wording,
  `aria-live`, the live region dropped while idle, `aria-hidden` on the dash, and
  the dash replaced by a 0. The CSV row for `first-refresh-loading` is updated.
- The third move, from `forge-health-budgets`: the toolbar's forge health was
  drawn inside `Dashboard.svelte`, so it is now its own `ForgeHealth` component
  and has stories. Two tests that checked the budget text's label (a single
  REST budget, and a Forgejo forge's own short name) are `play` functions on
  those stories. About 0.29 s of e2e test time became about 0.02 s of story
  time. Each assertion was proven red by breaking the component: the Forgejo
  short name, `aria-live="off"` on a budget, the overview threshold, the kind in
  the label, the unreachable-forge guard, and the `rate_limited` cause line.
  The other tests in the spec stay, since they read the page's banner or its
  live region. The CSV row for `forge-health-budgets` is updated.
- The fourth move, from `error-pages` and `insights-webhooks-read-failure`:
  the dashboard's error page and the read-failure alert already had stories,
  so no component changed. `error-pages` lost the two "Try again" tests, which
  are now `play` functions on the `ErrorPage` stories, and its journey test
  gave up the status chip, the way home and the four section links to the same
  stories. It keeps the title, the headline (so the built `404.html` and
  `500.html` are known to carry the component), axe at two widths, the layout
  overflow check and the no-internals check. `insights-webhooks-read-failure`
  gave up the Retry focus outline to the `ReadFailureAlert` stories, which also
  pin the alert role, the message, the Retry name and click, and the empty
  state. The 44px phone target stays in e2e, since it needs a 390px viewport
  that a story can't set. The wording tests stay: they check that a failed
  read reaches the alert. About 5.9 s of e2e test time (16 test runs) became
  about 4.6 s (14), and the stories take about 0.1 s. Each assertion was proven
  red by breaking the component: the 404 and 500 headlines, the status chip,
  the home link, a section link, Try again shown on a 404, dropped on a 500 or
  pointing elsewhere, the alert role, the Retry label, its click, the alert
  shown when empty, a page's own message, and the Retry focus outline. The CSV
  rows for both specs are updated.
- The fifth move, from `main-branch-advisories`: the Branches page's two
  advisories notices (GitHub and Forgejo) were built inside the page, so they
  are now `AdvisoriesNotice.svelte` with nine stories (each cause, for each
  forge). The refusal test is gone, the rate-limit test shrank to the check that
  the shared cause reaches the notice, and the wording, link and no-permission
  checks in the two "every answer unknown" tests are `play` functions. The
  counts, the absent pills and cues, axe in both themes and the overflow checks
  stay, since they read the page. The banner's CSS moved to `style.css` so a
  story draws it. About 7.8 s of e2e test time (14 test runs) became about 6.8 s
  (13). Each assertion was proven red by breaking the component: the grant
  link's condition, the Forgejo link's wording and its target. The CSV row for
  `main-branch-advisories` is updated.
- The sixth move, from `copy-failure`: the Copy button beside a failed action
  is already a function of the failure details and the class it is given, so
  no component changed. `CopyDetails.stories.svelte` draws the real
  `copyButton` in the three places the page puts it (a row's failure line, a
  toast and the pipeline panel's rerun failure). The "Copied, then Copy again"
  test is gone (it waited out the two-second timer), and the clipboard-refused
  test shrank to the check that a row's Copy reaches the details box. The
  button's label, name and type, the JSON it writes, the revert after two
  seconds, and the box's name, `readonly`, rows, value, selection and place
  (after a row's line, inside a toast or the panel) are `play` functions, for a
  refused clipboard and for none at all. The journeys that read the clipboard
  through a real failure stay, since they check what the page puts in the
  details. About 14.6 s of e2e test time (22 runs) became about 11.6 s (21),
  and the seven stories take about 0.1 s. Each assertion was proven red by
  breaking the button: its label, name, type and class, the Copied wording, the
  two-second delay, the revert, the indentation and the text written, the box's
  `readonly`, name, rows, class, value, selection and place in each of the
  three hosts, the box being reused, and the synchronous and asynchronous
  clipboard failures not reaching the box. Moving focus to the box is not
  separable, since `select()` focuses it, so the story pins the end state. The
  CSV row for `copy-failure` is updated.
- The seventh move, from `pipeline-run-output`: `CheckRunOutput` already had
  stories for its shapes, and they now hold the words too. The cut note's
  sentence and job link, the missing output's sentence and link, the refused
  read's plain sentence (never the forge's own words) and link, and a new
  "Rate limited" story with no link are `play` functions, down to the link's
  name, `href`, `target`, `rel` and new-tab mark and the note's and error's
  size and colour. The rate-limit test and the missing-output test are gone.
  The cut and refused tests shrank to their axe runs and the refused row's
  Copy output button and absent icon buttons, since those read the dialog. The
  other 49 tests are untouched. About 22.0 s of e2e test time (60 runs)
  became about 20.6 s (58). Both are measured here, summing the per-test
  durations on one worker with the machine idle, so they are not comparable
  with the CI figures in `tests/e2e-durations.json`. At the time of that move
  the est. movable was 10.1 s (20.6 times 25 of 51 tests), an upper bound and
  not a saving. The
  new stories take about 0.1 s. Each assertion was proven red by breaking
  the component, `run-log.ts` or the style sheet (see the pull request for the
  list). The CSV row for `pipeline-run-output` is updated.
- The eighth move, from `live-control`: the control itself had no story, so
  `LiveControl.stories.svelte` has seven. They check the group's name and role,
  the status word and its decorative dot, the updated time (and its absence
  before a first snapshot), the order of status, time, Pause and refresh, each
  button's id, type, label and visible word, Resume's name, the refreshing
  state (`aria-disabled` rather than `disabled`, the class, focus kept, a press
  ignored), the page-owned pause and resume cycle, and axe in both themes, live
  and paused. The Branches "leads the header" test is gone, since its Pause and
  Resume wiring is also exercised by the paused-page test below it, and each
  card's first test now only checks that the control leads its header and
  carries a time. The 44px targets and the page-wide axe runs at 360, 390 and
  1280px stay, as does everything that needs a snapshot or a stream. The
  saving is small and the measurement says so: on one worker with the machine
  idle (load under 5), the spec took 12.7 s over 28 runs before and 13.1 s over
  27 runs after, which is noise. The removed test took about 0.17 s, the
  rewritten card tests changed by less than 0.03 s each. At the time of that
  move the row read 13.148 s with 12 tests and 4 browser-only, so its est.
  movable was 8.8 s (13.148 times 8 of 12 tests), an upper bound and not a
  saving. The row had no duration before, so it read 0.0. Each assertion was
  proven red by breaking the component or `live-control.ts` on a scratch copy
  (see the pull request for the list).
- The ninth move, from `footer-consistency`: `Footer` already had stories
  for its version states, so no component changed. They are now `play`
  functions: the four links and their order, the GitHub link's `href`,
  `target`, `rel` and decorative mark, the version, Disclaimer and Privacy
  `href`s, nothing marked current on the home page, the dev label's wording,
  the one link marked `aria-current="page"` on the disclaimer, privacy and
  changelog pages, the current link's 2px underline, and axe in both themes.
  The "dev build" test is gone (a story on `/disclaimer.html` holds the same
  assertions, and the error-pages test still reads the real dev label), and the
  360px test gave up its underline check. The page-by-page footer checks, the
  real error pages, the layout match across pages and axe with the overflow
  check stay, since they read real pages. On one worker the spec took 5.3 s
  over 7 runs before and 4.3 s over 6 after. The eight stories take about 0.1
  s each. Each assertion was proven red by breaking the component or its style
  rule (see the pull request for the list). The CSV row for
  `footer-consistency` is updated.
- The tenth move, from `pipeline-run-output`: `PipelineDialog` already had
  stories, so no component changed. Four new ones draw what a row offers
  beside its name: "GitHub queued and running" (a queued or running GitHub job
  has no Show output, only Open on GitHub or Watch on GitHub, and a finished
  one has Show output), "Forgejo running" (Show output stays, since Forgejo
  streams a log), "Forgejo queued" (Open on Forgejo, never GitHub) and "Links
  that leave the dashboard" (each link's name with its new-tab warning, one
  decorative icon, `target`, `rel`, a check with no job id keeping its plain
  Open check page link, and the run link in the footer). The five e2e tests that
  held these are gone. The remaining 50 tests read the page's copy flows and stay.
  On one worker the spec took 26.9 s over 60 runs before and 24.4 s over 55
  after, on a machine with a load of about 7, so the saving is indicative. At the
  time of that move the est. movable was 11.7 s (24.4 times 24 of 50 tests), an
  upper bound and not a saving. The regenerated CSV reads the CI durations and
  the current test count instead. Each assertion was proven red
  by breaking the code: the Watch wording, the forge's name in the link, a
  running GitHub job and a queued job getting Show output, Forgejo losing Show
  output while running, the link's `target`, the new-tab warning on the run link
  and the icon.
- The eleventh move, from `related-band`: `RelatedBand` already had stories,
  and the pill builders they draw are the ones the pull request and issue
  dialog use, so no component changed. Five new stories hold what five groups of
  tests checked: the accessible name of each pill in a pull request's Closes,
  Refs, and Mentions rows (a Refs pill for a repository the dashboard does not
  track names the forge and the new tab), the Closed by and Referenced by
  labels and the Referenced by pill's name, a Mentioned by row of five that has
  no toggle and counts items, a row of
  seven that folds to six with a "+1 more" toggle, and the toggle opened and
  folded with Enter and Space (its text, `aria-expanded` and accessible name).
  Each story also checks that no line of its own sits under a row. Five tests
  are gone (the pill names, the Mentioned by hint loop, the Referenced by row,
  the Referenced by name and the fold by keyboard). The hint loop ran one test
  at six row sizes; the stories keep the boundary (five and seven) and the rest
  ran the same code. The tests that read the page stay: the band's place
  between the title and the description, the closing pill name with a draft and
  its pipeline, the click-through, the refresh patching, the tooltips, the
  contrast and the axe runs. On one worker with a load of about 9.4, the spec
  took 15.5 s over 35 runs before and 14.2 s over 26 after, so the saving is
  indicative. The five stories take about 0.1 s each. Each assertion was proven
  red by breaking the code: the forge wording and the Closes wording of a pill's
  name, the Referenced by label, the "+N more" and "Show fewer" text, the fold
  limit, `aria-expanded`, the toggle's accessible name and a hint line added
  to a row. The CSV row for `related-band` is updated.
- The twelfth move, from `pipeline-run-output` again: `CheckRunOutput` already
  had stories for its notes and errors, so no component changed. Four new ones
  hold what four tests checked: the status line after Copy output on a cut log
  (which part was copied and where the rest is) and on an empty output
  ("Nothing was copied."), the field to copy by hand when the browser refuses
  every route (its text, its focus and the Ctrl+C line), and opening the output
  with Enter, focusing it and hiding it again. The clipboard is faked per story
  and put back afterwards. The four tests are gone. The copy flows that read the
  page (the row's two Copy buttons, rerun, closing the dialog mid-read) stay, as
  does the first test, which keeps the axe run of the dialog. Each assertion was
  proven red by breaking the code: the three status wordings, and the output's
  `tabindex`.
- trim the proven partial overlaps: `first-refresh-loading`, `rerun-all`,
  `cancel-run`, `settings-groups` (done: six tests that only restated
  a lib predicate or wording are gone, and the durations in
  `tests/e2e-durations.json` refresh the next time a green `main` run is
  recorded).
- pin `settlesOnRow` in `wait-chip.test.ts`, then trim `wait-chip` (done: two
  tests that only restated `autoMergeChip` wording are gone, and the duration
  in `tests/e2e-durations.json` refreshes the next time a green `main` run is
  recorded).
- prove the class B specs with Go mutations, then trim them (done: `webhooks`
  and `filter-newer-wins` are deleted, the rest stay for the reason in the class
  B section).
- cut `filter-every-control` rounds and move its round-trip and cookie checks
  down (done: twelve pull request rounds and three on Issues and Webhooks became
  two, one and one, each read back by a client navigation, a cookie-only reload
  and a server-copy-only reload, instead of five ways. The spec went from about
  30 s to about 8 s of test time on one worker; `tests/e2e-durations.json` holds
  the local figure until a green `main` run records one. The cookie half is
  `web/src/lib/filters-cookie-roundtrip.test.ts`: every pill, and every group
  and key a control saves, comes back from the cookie. The server half is
  `TestFilterStatePut_ThenGet_RoundTripsEveryGroupAndKey` in
  `internal/api/filter_state_test.go`. Each was proven red by breaking the code
  it covers: the forge pill saved under the wrong group, the issue, webhooks or
  pull request group not read back, the cookie value not URL-encoded, an off box
  read back as on, and the server returning empty values as `0` or dropping the
  webhooks group).
- trim `dashboard` (partly done): the "CI pill wording beside the Merge
  button" test is gone. It only read the word `Failed` on a failing row, which
  `row-status-grammar.spec.ts` ("a run turns into its result in the same box")
  and `ci-pill-counts.spec.ts` (the failed-pill tests) read too. Changing the
  word in `Dashboard.svelte` turns all three red. The durations in
  `tests/e2e-durations.json` refresh the next time a green `main` run is
  recorded. Still open on `dashboard`: the presence-only test and the two axe
  scans.
- record a duration for the 17 specs that have none, so they rank (done: the
  file was refreshed from a green `main` run, which gave all of them and the
  specs added since an entry. Only specs newer than that run are missing, and
  the next refresh adds them).
