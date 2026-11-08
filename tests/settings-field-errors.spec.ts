import { expect } from '@playwright/test';
import { test } from './server-fixture';

// A refused save names the field in the API's own words ("forgejoUrl must
// be..."). The message belongs under the field it is about, in the words on
// that field's label, and tied to the input for a screen reader.
// https://github.com/alrayyes/forge-dashboard/issues/3213

test('a refused Forgejo URL is explained under the field, by its label', async ({
  page,
}) => {
  await page.goto('/settings.html#connections');
  const input = page.locator('#forgejo-url');
  await input.fill('ftp://nope');
  await page.locator('#save-connections-button').click();

  const error = page.locator('#forgejo-url-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText(
    'Instance URL must be an http:// or https:// address with a host',
  );
  await expect(error).not.toContainText('forgejoUrl');

  // Directly under the input, not under the Save button.
  const inputBox = await input.boundingBox();
  const errorBox = await error.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(errorBox).not.toBeNull();
  const inputBottom = inputBox!.y + inputBox!.height;
  expect(errorBox!.y).toBeGreaterThanOrEqual(inputBottom);
  expect(errorBox!.y - inputBottom).toBeLessThan(40);

  await expect(input).toHaveAttribute('aria-invalid', 'true');
  const described = (
    (await input.getAttribute('aria-describedby')) ?? ''
  ).split(/\s+/);
  expect(described).toContain('forgejo-url-error');
  expect(described).toContain('forgejo-url-hint');
});

test('another Connections field gets the same wiring', async ({ page }) => {
  await page.goto('/settings.html#connections');
  await page.locator('#forgejo-url').fill('https://git.example.com');
  const input = page.locator('#forgejo-username');
  await input.fill('x'.repeat(65));
  await page.locator('#save-connections-button').click();

  const error = page.locator('#forgejo-username-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Forgejo username is too long');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(
    ((await input.getAttribute('aria-describedby')) ?? '').split(/\s+/),
  ).toContain('forgejo-username-error');
});

test('a Behaviour field gets the same wiring', async ({ page }) => {
  await page.goto('/settings.html#behaviour');
  const input = page.locator('#renovate-rebase-label');
  await input.fill('x'.repeat(101));
  await page.locator('#save-button').click();

  const error = page.locator('#renovate-rebase-label-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Renovate rebase label is too long');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(
    ((await input.getAttribute('aria-describedby')) ?? '').split(/\s+/),
  ).toContain('renovate-rebase-label-error');
});

test('correcting the field and saving removes the error', async ({ page }) => {
  await page.goto('/settings.html#connections');
  const input = page.locator('#forgejo-url');
  await input.fill('ftp://nope');
  await page.locator('#save-connections-button').click();
  await expect(page.locator('#forgejo-url-error')).toBeVisible();

  await input.fill('https://git.example.com');
  await page.locator('#save-connections-button').click();
  await expect(page.locator('#connections-status')).toHaveText('Saved.');
  await expect(page.locator('#forgejo-url-error')).toBeHidden();
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');
  expect(await input.getAttribute('aria-describedby')).toBe('forgejo-url-hint');
});
