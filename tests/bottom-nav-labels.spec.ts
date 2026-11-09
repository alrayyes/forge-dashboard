import { expect } from '@playwright/test';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3288
//
// With all eight tabs showing, the bottom nav's labels collided at 320px
// (the WCAG 1.4.10 Reflow width): Webhooks (48px) overflowed its 40px tab and
// touched Insights and Settings, and Branches began off-screen. Every label
// must sit inside the viewport and inside its own tab, with at least 2px
// between neighbours.

const WIDTHS = [320, 360, 375, 390, 412];

test.describe('bottom nav labels (#3288)', () => {
  for (const width of WIDTHS) {
    test(`labels are separate and inside their tabs at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 700 });
      // A count that isn't known yet keeps its tab in the bar, so with the
      // dashboard read refused all eight tabs show.
      await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
      await page.route('**/api/v1/dashboard*', (route) => route.abort());
      await page.goto('/insights.html');
      await expect(page.locator('.bottom-nav-label')).toHaveCount(8);

      const boxes = await page.$$eval('.bottom-nav-link', (links) =>
        links.map((link) => {
          const label = link.querySelector('.bottom-nav-label');
          const l = label?.getBoundingClientRect();
          const t = link.getBoundingClientRect();
          return {
            name: label?.textContent?.trim() ?? '',
            left: l?.left ?? 0,
            right: l?.right ?? 0,
            tabLeft: t.left,
            tabRight: t.right,
          };
        }),
      );

      const problems: string[] = [];
      for (const [i, b] of boxes.entries()) {
        if (b.left < 0 || b.right > width)
          problems.push(`${b.name} leaves the viewport (${b.left}-${b.right})`);
        if (b.left < b.tabLeft - 0.01 || b.right > b.tabRight + 0.01)
          problems.push(
            `${b.name} ${b.left.toFixed(1)}-${b.right.toFixed(1)} overflows its tab ${b.tabLeft.toFixed(1)}-${b.tabRight.toFixed(1)}`,
          );
        const next = boxes[i + 1];
        if (next && next.left - b.right < 2)
          problems.push(
            `${b.name}/${next.name} gap ${(next.left - b.right).toFixed(1)}px`,
          );
      }
      expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
    });
  }
});
