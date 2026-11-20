import { expect, test } from 'bun:test';
import { MARGIN, planShot, shotName, VARIANTS } from './storybook-shots';

// https://github.com/alrayyes/forge-dashboard/issues/3872
//
// The screenshot script crops each story to its component, takes it at three
// sizes and skips a story that draws nothing.
const viewport = { width: 1280, height: 800 };
const none = { box: null, overlay: false };

test('names the desktop shot for the story and the others for the variant', () => {
  const names = VARIANTS.map((v) => shotName('button--primary', v));
  expect(names).toEqual([
    'button--primary.png',
    'button--primary--phone.png',
    'button--primary--dark.png',
  ]);
});

test('phone is 390px wide and dark asks for the dark colour scheme', () => {
  const phone = VARIANTS.find((v) => v.name === 'phone');
  const dark = VARIANTS.find((v) => v.name === 'dark');
  expect(phone?.viewport.width).toBe(390);
  expect(dark?.colorScheme).toBe('dark');
});

test('crops to the component with a margin', () => {
  const plan = planShot(
    { box: { x: 100, y: 50, width: 200, height: 40 }, overlay: false },
    viewport,
  );
  expect(plan).toEqual({
    kind: 'clip',
    clip: {
      x: 100 - MARGIN,
      y: 50 - MARGIN,
      width: 200 + 2 * MARGIN,
      height: 40 + 2 * MARGIN,
    },
  });
});

test('keeps the crop inside the page', () => {
  const plan = planShot(
    { box: { x: 2, y: 0, width: 1400, height: 40 }, overlay: false },
    viewport,
  );
  expect(plan).toEqual({
    kind: 'clip',
    clip: { x: 0, y: 0, width: 1280, height: 40 + MARGIN },
  });
});

test('keeps the whole page, and its backdrop, for a dialog', () => {
  const plan = planShot(
    { box: { x: 400, y: 300, width: 480, height: 200 }, overlay: true },
    viewport,
  );
  expect(plan).toEqual({ kind: 'full' });
});

test('says a story that draws nothing renders nothing', () => {
  expect(planShot(none, viewport)).toEqual({ kind: 'blank' });
  expect(
    planShot(
      { box: { x: 8, y: 8, width: 0, height: 0 }, overlay: false },
      viewport,
    ),
  ).toEqual({ kind: 'blank' });
});
