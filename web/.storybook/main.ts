import type { StorybookConfig } from '@storybook/sveltekit';

// The component catalog (#3239): one story per state that matters, next to
// its component. Built and screenshotted by scripts/storybook-screenshots.ts.
const config: StorybookConfig = {
  stories: ['../src/lib/**/*.stories.svelte'],
  addons: ['@storybook/addon-svelte-csf'],
  framework: '@storybook/sveltekit',
  core: { disableTelemetry: true },
};

export default config;
