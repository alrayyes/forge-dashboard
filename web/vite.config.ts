import { readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { transform } from 'lightningcss';
import { defineConfig, type Plugin } from 'vite';

// style.css is the app's one global stylesheet, linked from app.html at a
// fixed URL ahead of every page's own <style> (ten pages inject theirs from
// <svelte:head> and count on loading second). Importing it from a layout
// would hash and minify it but move it after those blocks, so this emits it
// minified at the same URL instead (#1135).
function minifiedStyleCss(): Plugin {
  return {
    name: 'minified-style-css',
    apply: 'build',
    generateBundle() {
      if (this.environment.name !== 'client') return;
      const path = new URL('./src/style.css', import.meta.url);
      const { code } = transform({
        filename: 'style.css',
        code: readFileSync(path),
        minify: true,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'style.css',
        source: code,
      });
    },
  };
}

export default defineConfig({
  plugins: [
    minifiedStyleCss(),
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
      // plus anything else static — see this repo's own
      // CONTRIBUTING.md), and scripts/sync-web-build.sh merges this
      // build into it rather than letting the adapter's own
      // directory-clearing behavior touch files it doesn't own.
      adapter: adapter({
        pages: 'build',
        assets: 'build',
        fallback: undefined,
        strict: true,
      }),

      // The layout's and footer's component CSS (about 4 KB) rides in each
      // page's HTML instead of two more render-blocking requests, and the
      // @font-face rules in it no longer wait for a stylesheet round trip
      // (#1069). style.css stays a separate file: its URL is immutable-cached,
      // and the HTML isn't (#1288).
      inlineStyleThreshold: 8192,

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
