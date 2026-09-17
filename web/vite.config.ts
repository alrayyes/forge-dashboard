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
      // build/ here, not straight into ../internal/api/static: the
      // hand-written pages that haven't migrated yet still live
      // there, and scripts/sync-web-build.sh merges this build into
      // that directory rather than letting the adapter's own
      // directory-clearing behavior touch files it doesn't own.
      adapter: adapter({
        pages: 'build',
        assets: 'build',
        fallback: undefined,
        strict: true,
      }),

      // The layout links to every other page (nav, footer, brand) —
      // most of those are still hand-written HTML this SvelteKit app
      // doesn't serve at all yet, so the prerender crawler 404s
      // following them out of this app's own dev-preview server.
      // That's expected until each one migrates too; only a broken
      // link *inside* this app's own route tree is a real error.
      prerender: {
        handleHttpError: ({
          path,
          message,
        }: {
          path: string;
          message: string;
        }) => {
          if (path.startsWith('/webhooks')) throw new Error(message);
        },
      },
    }),
  ],
});
