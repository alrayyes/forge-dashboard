const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { registerViaInvite } = require('./register-helper');

function uniqueUsername(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

const registerUser = registerViaInvite;

test.describe('dashboard sharing', () => {
  test('sharing makes the owner selectable from the viewer header, and stopping sharing removes it from settings', async ({
    browser,
    request,
    baseURL,
  }) => {
    const ownerUsername = uniqueUsername('sharing-owner');
    const viewerUsername = uniqueUsername('sharing-viewer');

    const ownerContext = await browser.newContext();
    try {
      const ownerPage = await ownerContext.newPage();
      await registerUser(
        ownerPage,
        request,
        baseURL,
        ownerUsername,
        'Sharing Owner',
      );

      const viewerContext = await browser.newContext();
      try {
        const viewerPage = await viewerContext.newPage();
        await registerUser(
          viewerPage,
          request,
          baseURL,
          viewerUsername,
          'Sharing Viewer',
        );

        await ownerPage.goto('/settings.html');
        await ownerPage.fill('#share-username', viewerUsername);
        await ownerPage.click('#share-form button[type="submit"]');
        await expect(ownerPage.locator('#share-status')).toContainText(
          'Shared',
        );
        await expect(ownerPage.locator('#shared-with-list')).toContainText(
          viewerUsername,
        );

        await viewerPage.reload();
        const ownerOption = viewerPage.locator(
          `#dashboard-owner-select option[value="${ownerUsername}"]`,
        );
        await expect(ownerOption).toHaveCount(1);
        await expect(
          viewerPage.locator('#dashboard-owner-select'),
        ).toBeVisible();

        await viewerPage.selectOption('#dashboard-owner-select', ownerUsername);
        // Switching owners re-fetches /api/dashboard?owner=<ownerUsername> —
        // no data differs from the viewer's own empty dashboard in this
        // test (neither user has forge credentials configured), so the
        // real assertion is that the request itself succeeds rather than
        // getting bounced to login or showing the error banner a 403/404
        // would trigger.
        await expect(viewerPage.locator('#error-banner')).toHaveCount(0);

        await ownerPage.goto('/settings.html');
        await ownerPage.click(
          '#shared-with-list button.btn-remove[data-username="' +
            viewerUsername +
            '"]',
        );
        await expect(ownerPage.locator('#share-status')).toContainText(
          'No longer shared',
        );
        await expect(ownerPage.locator('#shared-with-empty')).toBeVisible();
      } finally {
        await viewerContext.close();
      }
    } finally {
      await ownerContext.close();
    }
  });

  test('has no axe-core violations on settings with an active share, at desktop and phone width', async ({
    browser,
    request,
    baseURL,
  }) => {
    const ownerUsername = uniqueUsername('sharing-axe-owner');
    const viewerUsername = uniqueUsername('sharing-axe-viewer');

    const ownerContext = await browser.newContext();
    try {
      const ownerPage = await ownerContext.newPage();
      await registerUser(
        ownerPage,
        request,
        baseURL,
        ownerUsername,
        'Axe Owner',
      );

      const viewerContext = await browser.newContext();
      try {
        const viewerPage = await viewerContext.newPage();
        await registerUser(
          viewerPage,
          request,
          baseURL,
          viewerUsername,
          'Axe Viewer',
        );
      } finally {
        await viewerContext.close();
      }

      await ownerPage.goto('/settings.html');
      await ownerPage.fill('#share-username', viewerUsername);
      await ownerPage.click('#share-form button[type="submit"]');
      await expect(ownerPage.locator('#shared-with-list')).toContainText(
        viewerUsername,
      );

      const desktopResults = await new AxeBuilder({ page: ownerPage })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(desktopResults.violations).toEqual([]);

      await ownerPage.setViewportSize({ width: 390, height: 844 });
      await ownerPage.reload();
      await expect(ownerPage.locator('#shared-with-list')).toContainText(
        viewerUsername,
      );

      const phoneResults = await new AxeBuilder({ page: ownerPage })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(phoneResults.violations).toEqual([]);

      const scrollWidth = await ownerPage.evaluate(
        () => document.documentElement.scrollWidth,
      );
      const clientWidth = await ownerPage.evaluate(
        () => document.documentElement.clientWidth,
      );
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    } finally {
      await ownerContext.close();
    }
  });

  test('a user who never shared sees no dashboard selector', async ({
    page,
    request,
    baseURL,
  }) => {
    await registerUser(
      page,
      request,
      baseURL,
      uniqueUsername('sharing-alone'),
      'Nobody Shared With Me',
    );

    await expect(page.locator('#dashboard-owner-select')).toBeHidden();
  });
});
