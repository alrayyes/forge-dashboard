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
| B Go covers the logic           | 6     | 20 s            |
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

`webhooks`, `settings-field-errors`, `filter-persistence`,
`main-branches-server-copy`, `filter-late-copy` and `filter-newer-wins` (20 s
together). The class is hand-picked, and the CSV names no Go test for them. No
Go mutation was run, so these stay unproven.

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

- Component test harness, so class C has somewhere to go (already filed).
- trim the proven partial overlaps: `first-refresh-loading`, `rerun-all`,
  `cancel-run`, `settings-groups`.
- pin `settlesOnRow` in `wait-chip.test.ts`, then trim `wait-chip`.
- prove the class B specs with Go mutations, then trim them.
- cut `filter-every-control` rounds and move its round-trip and cookie checks
  down.
- record a duration for the 17 specs that have none, so they rank.
