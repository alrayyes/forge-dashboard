import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ReadFailureAlert from './ReadFailureAlert.svelte';

// The banner's states are stories. This is what a story shouldn't carry: how it
// lays out, which only shows once the app's global stylesheet is loaded.
test('the banner lays out from the global stylesheet', async () => {
  const screen = await render(ReadFailureAlert, {
    message: 'The backend answered with an error (500).',
  });

  await expect
    .element(screen.getByRole('alert'))
    .toHaveStyle({ display: 'flex' });
});
