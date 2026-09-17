# web

The frontend, migrated incrementally to SvelteKit off the handwritten
vanilla-JS pages still living in `../internal/api/static`. See the root
`README.md` for how the whole app runs, and `../CONTRIBUTING.md` for the
full toolchain and hooks. The decision to adopt SvelteKit this way is
recorded in
[issue #326](https://github.com/alrayyes/forge-dashboard/issues/326).

## What's here

A route under `src/routes/` per migrated page — `webhooks/` is the first
one. Each prerenders to a plain static file via `@sveltejs/adapter-static`
(no Node server at request time), matching the shape the Go binary already
embeds and serves.

## Building

Never run this directory's own build in isolation for a real check — the
root `bun run build:web` does the build and then merges the output into
`../internal/api/static`, which `//go:embed` reads at Go compile time.
That merge step is the part that actually matters; `vite build` alone
just writes to `build/`, which nothing serves on its own.

```sh
bun run --filter web build   # or: bun run build:web, from the repo root
```

## Developing

`bun run --filter web dev` starts Vite's dev server, but it won't have the
shared assets (`style.css`, `theme.js`, the nav/footer scripts) available —
those are served from `internal/api/static` at runtime, not copied into
this workspace. Iterate against a real build instead: `bun run build:web`
from the repo root, then `go build && ./forge-dashboard` as the root
README's "Running it" section describes.

## Checking

`bun run --filter web check` (or `bun run check:web` from the root) runs
`svelte-check` — the TypeScript compiler plus the Svelte compiler's own
accessibility and unused-CSS diagnostics. Biome has no Svelte parser, so
`biome.json` excludes `.svelte` entirely; this is that file type's own
check, the same role `svelte-check` plays in CI.
