import { expect } from '@playwright/test';
import { test } from './server-fixture';

// The Behaviour cards open with a `.field-hint` outside any `.field`, so the
// `.field .field-hint` rule missed them and they fell back to 16px, the size
// of the labels and inputs. Card-level hints get the helper style too. The
// axe sweep over every group lives in settings-groups.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/3365

const GROUPS = ['display', 'connections', 'behaviour', 'integrations'];

test.use({ viewport: { width: 320, height: 800 } });

for (const scheme of ['light', 'dark'] as const) {
  for (const group of GROUPS) {
    test(`${group} helper text is smaller than the controls in ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`/settings.html#${group}`);
      await expect(page.locator(`#${group}`)).toBeVisible();

      // The sizes are read inside the poll, so a hint that is still taking
      // its style does not fail the run.
      const misfits = () =>
        page.locator(`#${group} .field-hint`).evaluateAll((els) =>
          els
            .filter((el) => (el as HTMLElement).offsetParent !== null)
            .flatMap((el) => {
              const cardLevel = el.closest('.field') === null;
              const s = getComputedStyle(el);
              const size = Number.parseFloat(s.fontSize);
              const lh = Number.parseFloat(s.lineHeight) || 1.5 * size;
              const lines = Math.round(el.getBoundingClientRect().height / lh);
              const text = (el.textContent ?? '').trim().slice(0, 40);
              const [min, max] = cardLevel && lines > 2 ? [13, 14] : [12, 16];
              const ok =
                size < 16 && size >= min && (max === 16 || size <= max);
              return ok ? [] : [`${text}: ${size}px`];
            }),
        );
      await expect.poll(misfits).toEqual([]);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow).toBe(false);
    });
  }
}
