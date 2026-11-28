## Why

Most of the web app sits in a few very large files. At `3d9d756b`,
`Dashboard.svelte` is about 12,700 lines, `style.css` 7,800, the Settings page
2,700, the details dialog 2,400 and `filters.ts` 2,200. Much of the dashboard is
set up imperatively inside one `initDashboard` function. A change in one feature
can't be read, tested or reviewed without the others, and two people can't work
there without colliding.

Cleaner code is worth something measurable to coding agents too: one controlled
study found the same pass rate with about 7% fewer input tokens and 34% fewer
file revisits ([arXiv 2605.20049](https://arxiv.org/html/2605.20049v1)). It did
not test file size.

## What Changes

- Generate the web app's API types from `api/openapi.yaml`, and stop writing
  them by hand.
- Put dashboard data in one store that both polling and the stream feed. Then
  move the page into components until `initDashboard` is gone.
- Move styles into the components that use them, turn shared looks into
  components, and delete unused classes.
- Split Settings, the details dialog and `filters.ts` by job. Delete the
  migrations for old saved-filter formats and keep the guards against bad data.
- Keep forge names out of the frontend outside the connection settings and
  setup, and enforce it.
- Enforce one-way imports between layers, feature by feature as each moves.
- Put each moved behaviour's tests at the lowest layer that can catch its bug.

No file size limit. Files are split by job. A line limit would force splits that
make code worse, and there's no objective number to pick
([ESLint `max-lines`](https://eslint.org/docs/rules/max-lines)).

The app behaves the same throughout. The one intended exception is that saved
filters in an old format are no longer converted.

## Capabilities

### New Capabilities

- `frontend-structure`: where frontend code lives, what may import what, and
  where its types and tests come from.

### Modified Capabilities

None.

## Impact

- `web/`, the build and CI checks, `CONTRIBUTING.md` and `ARCHITECTURE.md`.
- No API or database change is planned.
- Tracked in #5182. Depends on the test-layer rules in #5180.
- While extraction is under way, other frontend work in a moved area waits.
