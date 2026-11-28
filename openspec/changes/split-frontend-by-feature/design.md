## Context

See the proposal. Releases are continuous, so every pull request has to ship on
its own. Business rules already live behind the API
([ADR 0001](../../../docs/adr/0001-business-rules-live-behind-the-api.md)), and
forges already report capabilities as data (#3969, #3972, #4073).

## Goals

- A feature can be changed by reading its own folder, the data layer and the
  shared UI.
- Each pull request leaves the app releasable.

## Non-Goals

- A separate frontend repository or service.
- Faster CI.
- Redesigning screens.
- A file size limit.

## Decisions

### Order

1. The test-layer change (#5180), all of it.
2. Generated API types.
3. The data store, then components with their styles and tests, one area at a
   time.
4. The forge-agnostic contract, one fact at a time.
5. Settings, the details dialog and `filters.ts`.

### Types

`openapi-typescript` generates from `api/openapi.yaml` during the build. The
output is not committed. The published SDK is not used: it lags the server by a
release. Version 7.13.0 declares a peer of TypeScript 5 while the repo pins
6.0.3, so the first task proves it works there or picks another generator and
records why. A change to `api/` must run the web type check, which the CI change
filter does not do today.

### Data store

- One handler takes both poll responses and stream messages and writes one
  store.
- The store is a class using `$state` and `$state.raw`. No state library.
- Polling stays, at the interval the server advises.
- The latest data, the shown data and row actions are kept apart. The page holds
  back updates while an action runs, a menu or dialog is open, updates are
  paused or the pointer rests on the list. That stays.
- The store covers what `initDashboard` loads. Branches, Insights and the
  navigation counts keep their own feeds.

A store alone does not stop focus loss. Keyed row components, which come next,
update rows in place.

### Layers

```
web/src/routes  -->  web/src/lib/features/<name>  -->  web/src/lib/data
                                |                      web/src/lib/ui
                                +-------------------->
```

Imports only go downward. A feature has one entry file and does not import
another feature. `data` and `ui` import no feature and no route, and `ui` takes
no data from `data`; types are fine. Files not yet moved are not covered, and a
moved file may import them until they move. Where a rule would force worse code,
relax it and say why in its configuration.

The tool must read `.svelte` files, which Biome here does not. Compare ESLint
and dependency-cruiser first.

### Styles

A style moves with the component that uses it. The global stylesheet keeps
colours, spacing, theme, fonts, element defaults and styles for rendered HTML.
A look shared by several features becomes a shared component. A class is deleted
only when no markup, DOM-building code or rendered HTML names it. Story
screenshots do not show the assembled page, so a style move compares page
screenshots taken before and after.

### Forge-agnostic

Outside connection settings and setup, no code decides behaviour or wording from
a forge's name; the API sends the fact. A fact the server doesn't know is sent
and shown as unknown, never as "no". The tables in `forges.ts` move to API data.
No generic form described by the backend.

Prose that names the products stays: the privacy and disclaimer pages, the
project link in the footer and the tool descriptions for agents. The check looks for forge identifiers and product names in code, strings and
markup, and lists these exceptions and the connection and
setup folders.

### Filters

Delete `migratePill`, `migrateCiStatus`, `migrateQuickPill` and
`migrateBareAuthors`, with `takeAuthorOverflow`, `takeMigratedStatus` and
`takeMigratedAuthor`. Keep guards against bad data, including
`dropUnknownClosing`. Old keys are currently carried along when read, so reading must drop them rather than save them back. The same goes for an old
bare author login under the current `author` key, which is otherwise held aside
and saved again. This is a behaviour change
and gets its own pull request, separate from splitting the file.

### Moves

Two pull requests per area, as #5180 sets out: move the code with its old tests
unchanged, then move the tests down.

### Collisions

- Open pull requests touching `Dashboard.svelte` merge before the first
  extraction.
- Settings waits for #5069, which removes fields from it, and which is gated on
  a manual test.
- Refactor tickets go first. A serious bug (a wrong or repeated action, lost
  data, an unusable page) jumps the queue. Other bugs and features in the area
  being moved wait. Backend and CI work carries on. The hold starts with the
  first extraction.

## Risks

- A big refactor next to continuous releases -> small pull requests, one area
  each, behaviour unchanged.
- The import rule or forge check produces false alarms -> relax with a stated
  reason.
