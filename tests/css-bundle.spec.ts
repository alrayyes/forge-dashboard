import { expect } from '@playwright/test';
import { test } from './fixtures';

// #1135: style.css used to be served as written, comments and all, and
// Lighthouse flagged it as unminified. The build now minifies it into the
// same URL, so it still loads ahead of every page's own styles.
test('style.css is served minified', async ({ request }) => {
  const res = await request.get('/style.css');
  expect(res.ok()).toBe(true);
  const css = await res.text();

  expect(css).not.toContain('/*');
  expect(css.split('\n').length).toBeLessThan(20);
  expect(css).toContain('--bg:');
});

test('pages still link style.css before their own styles', async ({
  request,
}) => {
  const html = await (await request.get('/login.html')).text();
  const sheet = html.indexOf('href="/style.css"');
  const firstInline = html.indexOf('<style');

  expect(sheet).toBeGreaterThan(-1);
  expect(firstInline).toBeGreaterThan(-1);
  expect(sheet).toBeLessThan(firstInline);
});
