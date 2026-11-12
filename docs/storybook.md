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
stories, then opens each one in Chromium at 1280 by 800 with animations off. It
saves one PNG per story to `docs/storybook/<story id>.png` (git ignored) and
runs axe over the same page. A story that throws, or any axe violation, fails
the run after every story has been tried.

It needs Playwright's Chromium. Run `bunx playwright install chromium` once.
`--static-dir=<dir>` serves a build you already made instead of building one,
and `--only=<text>` keeps the stories whose ID contains the text.

To browse the catalogue instead, run `bunx storybook dev` in `web/`.

`bun run test:storybook` is the smoke test: the build succeeds and lists at
least one story.

## What a story mocks

Stories run the real component. Only what Storybook can't run is replaced:

- `$app/*` imports, through the SvelteKit framework's `parameters`.
- `fetch`, with `web/.storybook/mock-fetch.ts`, because there's no Go server.
- The live check feed behind the pipeline dialog, with
  `web/.storybook/mock-feed.ts`.
- Logos: the page asks the image proxy for them, so the script answers a
  `/api/v1/images` request whose `url` is on `logos.example.test` itself, and
  blocks every other request that leaves the machine.

A dialog opens from a small button in the story, and a `play` function clicks it.

## Where it runs

The pre-push hook and the `storybook` CI job both run
`bun run storybook:screenshots`, so they can't disagree. CI uploads the images as
the `storybook-screenshots` artifact for a week.
