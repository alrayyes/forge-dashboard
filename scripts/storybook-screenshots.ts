// Screenshots every Storybook story and scans each with axe (#3239).
//
//   bun run storybook:screenshots
//
// 1. `storybook build` writes the catalog to a temp directory.
// 2. The build is served, and the script waits until index.json lists stories.
// 3. Each `type: "story"` entry opens at iframe.html?id=<id>&viewMode=story,
//    the play function runs to its end, and PNGs named for the story ID
//    land in docs/storybook/: desktop, `--phone` (390px) and `--dark`. Each
//    is cropped to what the story drew, or the whole page when a dialog is
//    open. A story that draws nothing is listed, not saved (storybook-shots.ts).
//    A few browsers share the shots out, one per core, up to four.
// 4. axe scans the same DOM state of every variant. Any violation, and any
//    story that throws, fails the run after every story has been tried.
//
// The lefthook pre-push job and the CI job both call this script. It does not
// use Storybook's test-runner (rules/storybook.md).

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AxeBuilder } from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from '@playwright/test';
import { logoAnswer } from './storybook-logo-route';
import {
  inParallel,
  type Measure,
  planShot,
  type ShotJob,
  type Stall,
  shotJobs,
  shotName,
  stallReport,
  VARIANTS,
  workerCount,
} from './storybook-shots';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web');
const OUT_DIR = path.join(ROOT, 'docs', 'storybook');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const STORY_TIMEOUT_MS = 15_000;

// The browser is handed this mark for the one logo path the stories use, and
// nothing else leaves the machine (see storybook-logo-route.ts).
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#4f46e5"/><path d="M9 9h14v4H13v3h8v4h-8v3H9z" fill="#fff"/></svg>';

type IndexEntry = { id: string; type: string };

// The build goes outside the checkout, so svelte-check and Biome never read it.
async function build(staticDir: string) {
  const proc = spawn(
    'bunx',
    ['storybook', 'build', '--quiet', '-o', staticDir],
    {
      cwd: WEB,
      stdio: 'inherit',
      env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: '1' },
    },
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('exit', resolve);
  });
  if (code !== 0) throw new Error('storybook build failed');
}

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
};

async function serve(staticDir: string) {
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.join(staticDir, path.normalize(rel));
    const inside = file.startsWith(staticDir + path.sep);
    const found = inside && (await stat(file).catch(() => null))?.isFile();
    if (!found) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { port, stop: () => server.close() };
}

// Waits for the port to answer, then for index.json to list a story, and says
// how long each took. A build that is served after it finishes answers both at
// once; the gap would show if the port ever came up first.
async function waitForIndex(base: string): Promise<IndexEntry[]> {
  const started = Date.now();
  let portAt: number | null = null;
  const deadline = started + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/index.json`);
      portAt ??= Date.now() - started;
      if (res.ok) {
        const body = (await res.json()) as {
          entries?: Record<string, IndexEntry>;
        };
        const stories = Object.values(body.entries ?? {}).filter(
          (e) => e.type === 'story',
        );
        if (stories.length > 0) {
          console.log(
            `port answered after ${portAt}ms, index.json listed ${stories.length} stories after ${Date.now() - started}ms`,
          );
          return stories;
        }
      }
    } catch {
      // The port is not up yet.
    }
    await sleep(100);
  }
  throw new Error('index.json never listed a story');
}

// A story is done when the preview's render reaches "finished", which is after
// its play function has returned.
//
// Both signals here are private to Storybook: window.__STORYBOOK_PREVIEW__
// .currentRender.phase, and patching emit on the channel at
// window.__STORYBOOK_ADDONS_CHANNEL__. Neither is a public API. Recheck them
// on every Storybook upgrade; a rename shows up as every story timing out.
// A failure is read off the preview channel's events as they are emitted: the
// channel's own listeners do not hear them.
// The hook is installed before the page's scripts run and keeps looking until
// the preview exists.
const WATCH = `
(() => {
  const state = (window.__storyState = { done: false, error: null, phases: [] });
  const failing = ['playFunctionThrewException', 'storyThrewException', 'storyErrored', 'storyMissing'];
  let wrapped = false;
  setInterval(() => {
    const channel = window.__STORYBOOK_ADDONS_CHANNEL__;
    if (channel && !wrapped) {
      wrapped = true;
      const emit = channel.emit.bind(channel);
      channel.emit = (name, ...args) => {
        if (failing.includes(name) && !state.error) {
          const e = args[0];
          state.error = (e && (e.message || e.title || e.description)) || name;
        }
        return emit(name, ...args);
      };
    }
    const phase = window.__STORYBOOK_PREVIEW__?.currentRender?.phase;
    if (phase && state.phases.at(-1)?.[0] !== phase) state.phases.push([phase, Math.round(performance.now())]);
    if (phase === 'finished' || phase === 'errored' || phase === 'aborted') state.done = true;
  }, 5);
})();
`;

const QUIET = `
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}`;

// Asks the page what the story drew: the box around everything visible in the
// root, and whether a dialog or fixed layer is up, whose backdrop is part of
// the picture.
function measureStory(): Measure {
  const root = document.querySelector('#storybook-root');
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const el of root?.querySelectorAll('*') ?? []) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  const overlay = [...document.body.querySelectorAll('*')].some(
    (el) =>
      (el instanceof HTMLDialogElement && el.open) ||
      (el.tagName !== 'SCRIPT' &&
        getComputedStyle(el).position === 'fixed' &&
        el.getBoundingClientRect().width > 0 &&
        el.getBoundingClientRect().height > 0),
  );
  const box =
    right > left && bottom > top
      ? { x: left, y: top, width: right - left, height: bottom - top }
      : null;
  return { box, overlay };
}

// A browser with one context for each size.
async function openContexts(browser: Browser) {
  const contexts = new Map<string, BrowserContext>();
  for (const variant of VARIANTS) {
    const context = await browser.newContext({
      viewport: variant.viewport,
      colorScheme: variant.colorScheme,
      timezoneId: 'UTC',
      locale: 'en-US',
      reducedMotion: 'reduce',
      deviceScaleFactor: 1,
    });
    await context.addInitScript(WATCH);
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      // A logo is asked of the image proxy, which Storybook doesn't run: answer
      // for the one address the stories use, keyed by the `url` it carries.
      if (url.pathname === '/api/v1/images') {
        return logoAnswer(url.pathname + url.search) === 'logo'
          ? route.fulfill({ contentType: 'image/svg+xml', body: LOGO_SVG })
          : route.abort();
      }
      if (url.hostname === 'localhost') return route.continue();
      return route.abort();
    });
    contexts.set(variant.name, context);
  }
  return contexts;
}

type Outcome = { saved: boolean; blank: boolean; failures: string[] };

// Keeps what a stalled page would be asked about afterwards: the requests it
// still has open and its last console messages.
function listen(page: Page) {
  const pending = new Set<string>();
  const messages: string[] = [];
  const say = (message: string) => {
    messages.push(message);
    if (messages.length > 10) messages.shift();
  };
  page.on('request', (r) => pending.add(r.url()));
  page.on('requestfinished', (r) => pending.delete(r.url()));
  page.on('requestfailed', (r) => pending.delete(r.url()));
  page.on('console', (m) => say(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => say(`page error: ${e.message}`));
  page.on('crash', () => say('the page crashed'));
  return () => ({ pending: [...pending], messages: [...messages] });
}

// Asks a stalled page where it stopped. A stuck page answers nothing, so the
// question has its own time limit.
function askStalled(page: Page): Promise<Stall['page']> {
  const answer = page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: runs in the page
    const { phases, error } = (window as any).__storyState;
    const frame = await new Promise<boolean>((resolve) => {
      requestAnimationFrame(() => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });
    return { phases, error, frame };
  });
  return Promise.race([answer, sleep(5000, null)]).catch(() => null);
}

// Waits for the story to finish, and says where it stopped if it never does.
async function waitForStory(page: Page, heard: ReturnType<typeof listen>) {
  try {
    await page.waitForFunction(
      // biome-ignore lint/suspicious/noExplicitAny: runs in the page
      () => (window as any).__storyState?.done === true,
      undefined,
      { timeout: STORY_TIMEOUT_MS },
    );
  } catch (err) {
    // What had been heard when time ran out, before asking adds to it.
    const before = heard();
    const report = stallReport({ page: await askStalled(page), ...before });
    throw new Error(`${err instanceof Error ? err.message : err}\n${report}`);
  }
}

// Shoots and scans one story at one size.
async function shootStory(
  context: BrowserContext,
  base: string,
  { id, variant }: ShotJob,
): Promise<Outcome> {
  const outcome: Outcome = { saved: false, blank: false, failures: [] };
  console.log(`- ${id}${variant.suffix}`);
  const page = await context.newPage();
  const heard = listen(page);
  try {
    await page.goto(`${base}/iframe.html?id=${id}&viewMode=story`);
    await page.waitForSelector('#storybook-root', {
      state: 'attached',
      timeout: STORY_TIMEOUT_MS,
    });
    await waitForStory(page, heard);
    const error = await page.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: runs in the page
      () => (window as any).__storyState.error as string | null,
    );
    if (error) {
      outcome.failures.push(
        `${id}${variant.suffix}: the story threw: ${error}`,
      );
      return outcome;
    }
    await page.addStyleTag({ content: QUIET });
    await page.evaluate(() => document.fonts.ready);
    const plan = planShot(await page.evaluate(measureStory), variant.viewport);
    if (plan.kind === 'blank') {
      // One line per story: the phone and dark runs say the same thing.
      outcome.blank = variant.name === 'desktop';
    } else {
      const file = path.join(OUT_DIR, shotName(id, variant));
      await page.screenshot(
        plan.kind === 'clip' ? { path: file, clip: plan.clip } : { path: file },
      );
      outcome.saved = true;
    }

    const { violations } = await new AxeBuilder({ page })
      .withTags(TAGS)
      .analyze();
    for (const v of violations)
      outcome.failures.push(
        `${id}${variant.suffix}: axe ${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
      );
  } catch (err) {
    outcome.failures.push(
      `${id}${variant.suffix}: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    await page.close();
  }
  return outcome;
}

async function main() {
  // `--static-dir=<dir>` serves an existing build instead of making one, and
  // `--only=<text>` keeps the
  // stories whose ID contains it. Both are for working on one story.
  const given = process.argv
    .find((a) => a.startsWith('--static-dir='))
    ?.slice(13);
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const staticDir = given
    ? path.resolve(given)
    : await mkdtemp(path.join(tmpdir(), 'forge-dashboard-storybook-'));
  if (!given) await build(staticDir);

  const server = await serve(staticDir);
  const base = `http://localhost:${server.port}`;
  const browsers: Browser[] = [];
  let outcomes: Outcome[] = [];
  let jobs: ShotJob[] = [];
  try {
    const stories = await waitForIndex(base);
    const chosen = stories.filter((s) => !only || s.id.includes(only));
    jobs = shotJobs(chosen.map((s) => s.id));
    const workers: Awaited<ReturnType<typeof openContexts>>[] = [];
    for (let i = 0; i < workerCount(availableParallelism()); i++) {
      const browser = await chromium.launch();
      browsers.push(browser);
      workers.push(await openContexts(browser));
    }
    console.log(`${jobs.length} shots in ${workers.length} browsers`);
    outcomes = await inParallel(jobs, workers.length, (job, worker) => {
      const context = workers[worker]?.get(job.variant.name);
      if (!context) throw new Error(`no context for ${job.variant.name}`);
      return shootStory(context, base, job);
    });
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
    server.stop();
    if (!given) await rm(staticDir, { recursive: true, force: true });
  }

  // In the order the shots were asked for, not the order they finished.
  const failures = outcomes.flatMap((o) => o.failures);
  const shot = outcomes.filter((o) => o.saved).length;
  const blank = jobs.filter((_, i) => outcomes[i]?.blank).map((j) => j.id);

  if (blank.length > 0)
    console.log(`renders nothing, not saved: ${blank.join(', ')}`);
  console.log(`saved ${shot} screenshots to ${path.relative(ROOT, OUT_DIR)}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} problem(s):\n`);
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
}

await main();
