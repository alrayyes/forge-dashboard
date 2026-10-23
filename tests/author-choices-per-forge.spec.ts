import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import {
  offeredValues,
  pickButton,
  pickedValues,
  pickOnly,
  pickPanel,
  pickTexts,
  togglePicks,
} from './label-filter-helper';
import { test } from './server-fixture';

// The same login on two forges is two people, so the Author filter offers
// each once under its forge and a pick matches only that forge's pull
// requests.
// https://github.com/alrayyes/forge-dashboard/issues/2621

const NOW = new Date().toISOString();

function pr(number: number, forge: string, author: string, repo: string) {
  return {
    forge,
    repo,
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author,
    authorAvatarUrl: '',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: NOW,
    updatedAt: NOW,
    mergeStatus: 'mergeable',
  };
}

// 1 and 2 are two different people called sam; 3 is only on GitHub.
const PRS = [
  pr(1, 'github', 'sam', 'acme/api'),
  pr(2, 'forgejo', 'sam', 'acme/api'),
  pr(3, 'github', 'kim', 'acme/web'),
];

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: NOW,
        forges: [
          { forge: 'github', reachable: true, repoCount: 2 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests: PRS,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row').first()).toBeVisible();
}

const rows = (page: Page) => page.locator('#pr-rows > .row');

test('one login on two forges is two author choices, under their forges', async ({
  page,
}) => {
  await open(page);
  expect(await offeredValues(page, 'author')).toEqual([
    'forgejo:sam',
    'github:kim',
    'github:sam',
  ]);
  expect(await pickTexts(page, 'author')).toEqual(['sam', 'kim', 'sam']);
  await pickButton(page, 'author').click();
  const panel = pickPanel(page, 'author');
  await expect(panel.getByRole('group', { name: 'Forgejo' })).toHaveCount(1);
  await expect(panel.getByRole('group', { name: 'GitHub' })).toHaveCount(1);
});

test('picking one sam lists only that forge, and the button names the forge', async ({
  page,
}) => {
  await open(page);
  await expect(rows(page)).toHaveCount(3);
  await togglePicks(page, 'author', 'forgejo:sam');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Pull request 2');
  await expect(pickButton(page, 'author')).toHaveText('sam (Forgejo)');

  await pickOnly(page, 'author', 'github:sam');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Pull request 1');
  expect(await pickedValues(page, 'author')).toEqual(['github:sam']);
});

test('the author panel has no accessibility violations with forge groups', async ({
  page,
}) => {
  await open(page);
  await pickButton(page, 'author').click();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
