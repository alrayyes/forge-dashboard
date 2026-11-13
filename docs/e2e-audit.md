# E2E audit: which specs could run below the browser

Read-only audit of every `tests/*.spec.ts` (252 files, 2,237 tests) against
`main`. No spec was edited, moved, or deleted. The per-spec table is
[`e2e-audit/spec-classes.csv`](e2e-audit/spec-classes.csv).
[`e2e-audit/classify.py`](e2e-audit/classify.py) regenerates it.

## Method

- Duration is the per-spec figure in `tests/e2e-durations.json`, in seconds. It
  sums to about 1,472 s over 235 specs. Seventeen specs have no recorded
  duration and count as 0; the CSV leaves the cell empty.
- Classes: **A** browser-only (layout, CSS, focus, keyboard, axe, viewport);
  **B** UI over logic a Go test covers; **C** UI over wording or state a unit or
  component test could cover; **D** fully covered below. A spec takes A when
  half or more of its tests use a browser-only API, or when listed by hand
  (`mono-figures`). The rest default to C. B is a hand-picked list of six specs,
  and D is set by hand from the two deleted specs, since neither is detected.
  Mixed specs get their dominant class.
- The token scan only sees assertions written in the spec body. Browser
  assertions held in a helper are missed, so such a spec reads as C when it is
  A. `mono-figures` is the known case and is set to A by hand; others may exist.
- "Est. movable" is an upper bound: spec duration times the share of its tests
  with no browser-only token. Time is assumed proportional to test count. It is
  not a measured saving.
- Most specs mock `/api/v1/dashboard` with `page.route`, so they check the UI
  over canned state. `web/` has 107 unit test files, all in `web/src/lib` (pure
  functions or fake DOM), and no Svelte component harness. Class C is therefore
  blocked on one, tracked as its own ticket, except where a lib function already
  carries the logic.
- A class D claim needs a mutation of the code under test that turns the lower
  test red. Name matching alone never earns D.

## Result

| Class                           | Specs | Summed duration |
| ------------------------------- | ----- | --------------- |
| A browser-only                  | 115   | 554 s           |
| B Go covers the logic           | 4     | 15 s            |
| C needs a lib or component test | 131   | 898 s           |
| D fully covered below           | 0     | 0 s             |

D is empty today. The two specs that qualified (`filter-save-order`,
`filter-mixed-case`) were deleted earlier with their own mutation proof. The
upper bound over classes B and C is about 671 s of the 1,472 s run, and almost
none of it is safe to cut until the lower test exists. The order that keeps
coverage is: write the lower test, prove it red under a mutation, then trim the
spec.

## Evidence per spec group

### Partly covered below (mutation run for this audit)

Each mutation was applied to the code under test, the named lower test file was
run, and the change was reverted.

| Spec                    | Lower test                            | Mutation                                                     | Result                 |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------ | ---------------------- |
| `first-refresh-loading` | `web/src/lib/first-refresh.test.ts`   | `firstRefreshLoading` returns false before the first settle  | 1 fail, red            |
| `rerun-all`             | `web/src/lib/rerun-all.test.ts`       | `showRerunAll` returns false while busy                      | 2 fail, red            |
| `cancel-run`            | `web/src/lib/cancel-run.test.ts`      | `cancelText` bare label changed                              | 1 fail, red            |
| `settings-groups`       | `web/src/lib/settings-groups.test.ts` | `groupFromHash` fallback returns an anchor and the direct id | 1 fail, red            |
| `wait-chip`             | `web/src/lib/wait-chip.test.ts`       | `settlesOnRow` stops listing `bot-rebase`                    | 0 fail, **not proven** |

The first four lower tests are sensitive to the logic they cover. Each spec
keeps its layout, keyboard, axe and state-machine tests, so none becomes class
D; only the tests that restate the same wording or predicate can go. The
`wait-chip` lower test does not pin `settlesOnRow`, so nothing in that spec may
be trimmed until it does.

### UI over logic Go covers (class B)

Six specs started here: `webhooks`, `settings-field-errors`,
`filter-persistence`, `main-branches-server-copy`, `filter-late-copy` and
`filter-newer-wins`. Each Go test below was run red under a mutation of the
server code it covers, and the change was reverted.

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

The other four stay. Their server side is a store that keeps the filter state
as written, covered in the table, and what each test asserts is the page's own
behaviour: the cookie against the copy, a pick kept through a detour, an edit
that beats a copy still loading, the error wired to its field. A server
mutation does not turn those red, and no lower test pins them yet. They stay
class B in the CSV until one does.

### UI over state a component test could cover (class C)

131 specs, 898 s. No lower test exists for most. Where a lib test partly matches
(`dashboard`, `settings`, `webhooks-filter-choices`), the CSV names it.
Confidence is low wherever no lower test was found.

### Browser-only (class A)

115 specs, 554 s. These stay. Some still carry state-only tests beside the
layout ones; the upper bound counts those.

## Specs worth moving first

Ranked by estimated movable seconds, class A excluded.

| #   | Spec                           | Duration | Tests | Browser-only | Est. movable | Lower test, or the missing one                          |
| --- | ------------------------------ | -------- | ----- | ------------ | ------------ | ------------------------------------------------------- |
| 1   | `dashboard`                    | 51.2 s   | 101   | 15           | 43.6 s       | `dashboard-read` partly; missing: row and state tests   |
| 2   | `filter-every-control`         | 29.8 s   | 3     | 0            | 29.8 s       | Missing: see below                                      |
| 3   | `cancel-run`                   | 25.4 s   | 24    | 7            | 18.0 s       | `cancel-run.test.ts` (proven); missing: dialog wording  |
| 4   | `settings`                     | 21.2 s   | 49    | 11           | 16.4 s       | Go settings tests for server rules; missing: form state |
| 5   | `settings-groups`              | 27.4 s   | 22    | 9            | 16.2 s       | `settings-groups.test.ts` (proven, hash routing only)   |
| 6   | `wait-chip`                    | 22.8 s   | 20    | 6            | 16.0 s       | `wait-chip.test.ts` (not proven)                        |
| 7   | `webhooks-page`                | 17.0 s   | 56    | 8            | 14.5 s       | Missing: page state tests                               |
| 8   | `pipeline-run-output`          | 26.8 s   | 53    | 26           | 13.7 s       | Missing: log-view state tests                           |
| 9   | `copy-failure`                 | 14.4 s   | 17    | 3            | 11.9 s       | Missing: clipboard failure message                      |
| 10  | `pr-dialog-actions`            | 21.6 s   | 30    | 14           | 11.5 s       | Missing: actions enabled                                |
| 11  | `first-refresh-loading`        | 21.1 s   | 13    | 6            | 11.4 s       | `first-refresh.test.ts` (proven); missing: banner state |
| 12  | `label-multi-select`           | 13.9 s   | 26    | 5            | 11.2 s       | Missing: selection state                                |
| 13  | `main-branches-page`           | 19.9 s   | 40    | 18           | 11.0 s       | `main-branch-snapshot-runs` partly; missing: page state |
| 14  | `pull-request-checks`          | 17.1 s   | 41    | 15           | 10.9 s       | Missing: checks list state                              |
| 15  | `pull-request-action-refusals` | 17.1 s   | 10    | 4            | 10.3 s       | Missing: refusal wording                                |

`filter-every-control` is a real navigation and cookie journey, and the token
scan cannot see that. It loops four read-backs over every control. Fewer rounds,
with the server round-trip in a Go test and cookie serialisation in a lib test,
would cut most of its 29.8 s.

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
- trim the proven partial overlaps: `first-refresh-loading`, `rerun-all`,
  `cancel-run`, `settings-groups` (done: six tests that only restated
  a lib predicate or wording are gone, and the durations in
  `tests/e2e-durations.json` refresh the next time a green `main` run is
  recorded).
- pin `settlesOnRow` in `wait-chip.test.ts`, then trim `wait-chip`.
- prove the class B specs with Go mutations, then trim them (done: `webhooks`
  and `filter-newer-wins` are deleted, the rest stay for the reason in the class
  B section).
- cut `filter-every-control` rounds and move its round-trip and cookie checks
  down.
- record a duration for the 17 specs that have none, so they rank (done: the
  file was refreshed from a green `main` run, which gave all of them and the
  specs added since an entry. Only specs newer than that run are missing, and
  the next refresh adds them).
