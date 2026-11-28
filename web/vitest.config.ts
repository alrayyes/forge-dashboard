// Two projects in a real Chromium, with no Go binary, database or WebAuthn
// setup. `storybook` runs every story, and a story's `play` function is its
// assertions (#3626). `component` runs the `*.component.ts` files, for checks
// that don't belong in the catalogue. `bun run test:components` runs both.
// Pure modules stay under `bun test` (`bun run test:unit`), which doesn't pick
// up either.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// A function, because Vitest writes each project's name into its instances.
const browser = () => ({
  enabled: true,
  headless: true,
  // Vitest's default is 60 s. Under load a slow Chromium start should be a
  // slow pass, not a failure, so it is explicit and larger.
  connectTimeout: 180_000,
  provider: playwright(),
  instances: [{ browser: 'chromium' as const }],
});

// The app's own Vite config brings the SvelteKit plugin, so a component
// compiles as it does in the catalogue and in the build.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // One file at a time: a busy machine starved parallel iframes of CPU
      // until they missed Vitest's 60 s ready timeout.
      fileParallelism: false,
      // Vitest allows .only unless CI is set, so the hook would pass what CI fails.
      allowOnly: false,
      projects: [
        {
          extends: true,
          plugins: [
            storybookTest({ configDir: path.join(dirname, '.storybook') }),
          ],
          test: { name: 'storybook', browser: browser() },
        },
        {
          extends: true,
          test: {
            name: 'component',
            include: ['src/**/*.component.ts'],
            setupFiles: ['./vitest.setup.component.ts'],
            browser: browser(),
          },
        },
      ],
    },
  }),
);
