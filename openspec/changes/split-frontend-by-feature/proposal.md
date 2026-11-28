## Why

Most of the web app sits in a few very large files. At `3d9d756b`,
`Dashboard.svelte` is about 12,700 lines, `style.css` 7,800, the Settings page
2,700, the details dialog 2,400 and `filters.ts` 2,200. Much of the dashboard is
set up imperatively inside one `initDashboard` function. A change in one feature
can't be read, tested or reviewed without the others.

Cleaner code also helps coding agents: one controlled study found the same pass
rate with about 7% fewer input tokens and 34% fewer file revisits
([arXiv 2605.20049](https://arxiv.org/html/2605.20049v1)). It did not set out
to compare file sizes.

## What Changes

- Generate the web app's API types from `api/openapi.yaml` and drop the
  hand-written copies.
- One handler for polling and the stream, writing one store. Then keyed row
  components, then the rest, until `initDashboard` is gone.
- Styles move into the components that use them.
- Split Settings into one component per section, the details dialog and
  `filters.ts` by job.
- Delete the migrations for old saved-filter formats, keeping the guards
  against bad data.
- Keep the frontend forge-agnostic outside connection settings and setup.
- Enforce downward-only imports, feature by feature as each moves.

No file size limit. Files are split by job. A line limit would force splits that
make code worse, and there is no objective number to pick
([ESLint `max-lines`](https://eslint.org/docs/rules/max-lines)).

The app behaves the same throughout. The one intended exception is that saved
filters in an old format are no longer converted.

## Capabilities

### New Capabilities

- `frontend-structure`: where frontend code and styles live, what may import
  what, how server data reaches the page and where its types come from.

### Modified Capabilities

None. `dashboard-filtering` names GitHub and Forgejo as choices a user sees; that
stays true when the choices come from API data.

## Impact

- `web/`, build and CI checks, `CONTRIBUTING.md`, `ARCHITECTURE.md` and `docs/`.
- `api/openapi.yaml` and `internal/` where the frontend needs a fact the API
  does not send yet.
- Tracked in #5182. Builds on the test-layer change (#5180), which owns where
  tests go and sets up plain component tests.
- While extraction is under way, other work in the area being moved waits,
  except serious bugs.
