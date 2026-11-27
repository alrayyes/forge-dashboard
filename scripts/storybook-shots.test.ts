import { expect, test } from 'bun:test';
import {
  inParallel,
  MARGIN,
  openRequests,
  planShot,
  shotJobs,
  shotName,
  stallReport,
  VARIANTS,
  workerCount,
} from './storybook-shots';

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

// https://github.com/alrayyes/forge-dashboard/issues/5034
//
// Shooting one story at a time made the CI job the longest in the run, so the
// shots are shared out between a few browsers.
test('shoots every story at every size, once', () => {
  const jobs = shotJobs(['a--one', 'b--two']);
  expect(jobs.map((j) => shotName(j.id, j.variant))).toEqual([
    'a--one.png',
    'b--two.png',
    'a--one--phone.png',
    'b--two--phone.png',
    'a--one--dark.png',
    'b--two--dark.png',
  ]);
});

test('uses a worker per core, from one up to four', () => {
  expect([0, 1, 2, 4, 32].map(workerCount)).toEqual([1, 1, 2, 4, 4]);
});

test('runs that many at once and answers in the order asked', async () => {
  const busy = new Set<number>();
  let most = 0;
  const results = await inParallel(
    [30, 5, 5, 5, 5, 5],
    3,
    async (ms, worker) => {
      expect(busy.has(worker)).toBe(false);
      busy.add(worker);
      most = Math.max(most, busy.size);
      await Bun.sleep(ms);
      busy.delete(worker);
      return `${ms}`;
    },
  );
  expect(most).toBe(3);
  expect(results).toEqual(['30', '5', '5', '5', '5', '5']);
});

test('fails when one of them throws', async () => {
  const run = inParallel([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('no browser');
    return n;
  });
  await expect(run).rejects.toThrow('no browser');
});

// https://github.com/alrayyes/forge-dashboard/issues/5051
//
// A story timed out once and the failure said only that 15s had passed, so
// there was nothing to find the cause with.
test('says where a story that never finished stopped', () => {
  const report = stallReport({
    page: {
      phases: [
        ['preparing', 40],
        ['playing', 120],
      ],
      error: null,
      frame: true,
    },
    pending: ['/assets/preview.js'],
    messages: ['error: boom'],
  });
  expect(report.split('\n')).toEqual([
    '    render phases: preparing at 40ms, playing at 120ms',
    '    story error: none',
    '    animation frames: running',
    '    requests still open: /assets/preview.js',
    '    console: error: boom',
  ]);
});

test('keeps a URL asked for twice open until both have ended', () => {
  const requests = openRequests<{ url: () => string }>();
  const first = { url: () => '/assets/preview.js' };
  const second = { url: () => '/assets/preview.js' };
  requests.opened(first);
  requests.opened(second);
  requests.ended(second);
  expect(requests.pending()).toEqual(['/assets/preview.js']);
  requests.ended(first);
  expect(requests.pending()).toEqual([]);
});

test('says so, and why, when the page could not be asked', () => {
  const report = stallReport({
    page: { unanswered: 'no answer in 5s' },
    pending: [],
    messages: [],
  });
  expect(report.split('\n')).toEqual([
    '    the page did not answer: no answer in 5s',
    '    requests still open: none',
    '    console: nothing',
  ]);
});

test('says so when no phase was seen and no frame came', () => {
  const report = stallReport({
    page: { phases: [], error: 'boom', frame: false },
    pending: [],
    messages: [],
  });
  expect(report).toContain('render phases: none seen');
  expect(report).toContain('story error: boom');
  expect(report).toContain('animation frames: stopped');
});
