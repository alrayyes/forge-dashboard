# Component catalogue

Every Svelte component that has more than one state has a Storybook story per
state, next to the component in `web/src/lib/*.stories.svelte`. The catalogue is
the inventory a design audit works from: it shows the open dialog, the error
and empty states, and focus, which a screenshot of a route misses.

## Running it

```sh
bun run storybook:screenshots
```

The script builds the catalogue, serves it, waits until `index.json` lists the
stories, then opens each one in Chromium with animations off. Each story is
shot three ways, and the variant is in the filename in `docs/storybook/` (git
ignored):

| File                    | viewport | Theme |
| ----------------------- | -------- | ----- |
| `<story id>.png`        | 1280×800 | light |
| `<story id>--phone.png` | 390×844  | light |
| `<story id>--dark.png`  | 1280×800 | dark  |

A shot is cropped to what the story drew, with a 16px margin. A story with an
open dialog or another fixed layer keeps the whole page, so the backdrop stays
in the picture. A story that draws nothing is listed as "renders nothing" at
the end of the run and gets no PNG. axe runs over every variant. A story that
throws, or any axe violation, fails the run after every story has been tried.

It needs Playwright's Chromium. Run `bunx playwright install chromium` once.
`--static-dir=<dir>` serves a build you already made instead of building one,
and `--only=<text>` keeps the stories whose ID contains the text.

To browse the catalogue instead, run `bunx storybook dev` in `web/`.

`bun run test:storybook` is the smoke test: the build succeeds and lists at
least one story.

## Stories as component tests

```sh
bun run test:components
```

Vitest and `@storybook/addon-vitest` open each story in Chromium and run its
`play` function. An assertion that throws fails the run. It needs
no Go binary, database or WebAuthn setup, only Playwright's Chromium, and it
takes a few seconds. `web/vitest.config.ts` holds the setup. A story with no
`play` function still counts: it fails if it throws on render. The same command
runs the plain component tests (`web/src/lib/*.component.ts`), which render a
component without adding it to the catalogue.

Where a new check goes:

- A pure function or a rune-free module: `bun test` (`web/src/lib/*.test.ts`).
- Markup, wording, focus, layout or styles of one component, with its API
  mocked: a component test. Needing a browser doesn't make it an end-to-end
  test.
  - A state worth looking at gets a story, with the checks in its `play`
    function.
  - An edge case or a regression goes in a plain component test,
    `web/src/lib/<Component>.component.ts`, so the catalogue doesn't fill with
    them.
- A page that needs the Go server, auth, the live stream or a navigation:
  Playwright (`tests/*.spec.ts`).

`NavPills.stories.svelte` is the worked example of a story with checks, and
`ReadFailureAlert.component.ts` of a plain component test. Make a test fail on purpose
(remove an attribute from the component) to see the story go red before you
trust it.

## What a story mocks

Stories run the real component. Only what Storybook can't run is replaced:

- `$app/*` imports, through the SvelteKit framework's `parameters`.
- `fetch`, with `web/.storybook/mock-fetch.ts`, because there's no Go server.
- The live check feed behind the pipeline dialog, with
  `web/.storybook/mock-feed.ts`.
- Logos: the page asks the image proxy for them. The script answers only
  `https://logos.example.test/forge-dashboard.svg`, with a small SVG, so that
  logo loads. It aborts every other path on that host (for example
  `https://logos.example.test/missing.png`), so that logo fails and the
  component renders nothing. It also blocks every other request that leaves
  the machine.

A dialog opens from a small button in the story, and a `play` function clicks it.

## Where it runs

The pre-push hook and the `storybook` CI job both run
`bun run storybook:screenshots` and then `bun run test:components`, so they
can't disagree. CI uploads the images as
the `storybook-screenshots` artifact for a week.
