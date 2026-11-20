// Component tests (#3626): every Storybook story is a test in a real
// Chromium, and a story's `play` function is its assertions. No Go binary,
// database or WebAuthn setup. `bun run test:components` runs it. Pure
// modules stay under `bun test` (`bun run test:unit`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// The app's own Vite config brings the SvelteKit plugin, so a story compiles
// as it does in the catalogue and in the build.
export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: [storybookTest({ configDir: path.join(dirname, '.storybook') })],
    test: {
      name: 'storybook',
      // One story file at a time: a busy machine starved parallel iframes of
      // CPU until they missed Vitest's 60 s ready timeout.
      fileParallelism: false,
      browser: {
        enabled: true,
        headless: true,
        // Vitest's default is 60 s. Under load a slow Chromium start should
        // be a slow pass, not a failure, so it is explicit and larger.
        connectTimeout: 180_000,
        provider: playwright(),
        instances: [{ browser: 'chromium' }],
      },
    },
  }),
);
