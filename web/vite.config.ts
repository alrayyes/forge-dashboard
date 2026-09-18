import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },

      // The Go binary embeds this app's build output via go:embed and
      // serves it itself — no Node runtime at request time, so every
      // route has to be prerenderable to plain files. Output goes to
      // build/ here, not straight into ../internal/api/static: that
      // directory also holds hand-maintained static assets this
      // SvelteKit build doesn't own at all (style.css, favicon.svg,
      // theme.js, filters.js, nav.js, footer.js — see this repo's own
      // CONTRIBUTING.md), and scripts/sync-web-build.sh merges this
      // build into it rather than letting the adapter's own
      // directory-clearing behavior touch files it doesn't own.
      adapter: adapter({
        pages: 'build',
        assets: 'build',
        fallback: undefined,
        strict: true,
      }),

      // Every page has migrated (#352) — the layout's own links (nav,
      // footer, brand) now all resolve inside this app's own route
      // tree, so a broken one is a real error again. The one standing
      // exception is style.css/favicon.svg: plain static assets that
      // live in internal/api/static and were never part of this
      // SvelteKit build at all (merged in later by
      // scripts/sync-web-build.sh) — the prerender crawler's own
      // dev-preview server has nothing to answer them with and never
      // will, regardless of how complete the migration is.
      prerender: {
        handleHttpError: ({
          path,
          message,
        }: {
          path: string;
          message: string;
        }) => {
          if (path === '/style.css' || path === '/favicon.svg') return;
          throw new Error(message);
        },
      },
    }),
  ],
});
