import { expect, type Locator } from '@playwright/test';

// Pressing a pill must not move it, not even for a moment. A final-width check
// misses a pill that animates its padding and settles back, so the page records
// every width that differs from the baseline while the press plays out, and the
// spec asserts the record is empty (#4456).

// The pills are in the DOM, laid out and still, so a baseline is a real width.
export async function laidOutWidths(pills: Locator): Promise<number[]> {
  const read = () =>
    pills.evaluateAll((ps) => ps.map((p) => p.getBoundingClientRect().width));
  let last = '';
  await expect
    .poll(async () => {
      const widths = await read();
      const now = JSON.stringify(widths);
      const still =
        widths.length > 0 && widths.every((w) => w > 0) && now === last;
      last = now;
      return still;
    })
    .toBe(true);
  return read();
}

// Press, then wait for every animation and transition the press started to end
// (no timer: the page says when it is done), and return the widths seen that
// differ from the baseline. Empty means the pill never moved.
export async function widthJumpsWhile(
  pills: Locator,
  baseline: number[],
  press: () => Promise<void>,
): Promise<number[][]> {
  const page = pills.page();
  await pills.evaluateAll((ps, base) => {
    const w = window as unknown as {
      __jumps: number[][];
      __jumpWatch?: ResizeObserver;
    };
    w.__jumpWatch?.disconnect();
    w.__jumps = [];
    const ro = new ResizeObserver(() => {
      const now = ps.map((p) => p.getBoundingClientRect().width);
      if (now.some((v, i) => v !== base[i])) w.__jumps.push(now);
    });
    w.__jumpWatch = ro;
    for (const p of ps) ro.observe(p, { box: 'border-box' });
  }, baseline);
  await press();
  await page.evaluate(async () => {
    const frame = () =>
      new Promise<void>((r) => requestAnimationFrame(() => r()));
    await frame();
    await frame();
    // Looping animations (a spinner) never finish and are not a press effect.
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => {})));
    await frame();
  });
  return page.evaluate(
    () => (window as unknown as { __jumps: number[][] }).__jumps,
  );
}
