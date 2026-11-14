// Screenshots every Storybook story and scans each with axe (#3239).
//
//   bun run storybook:screenshots
//
// 1. `storybook build` writes the catalog to a temp directory.
// 2. The build is served, and the script waits until index.json lists stories.
// 3. Each `type: "story"` entry opens at iframe.html?id=<id>&viewMode=story,
//    the play function runs to its end, and one PNG named for the story ID
//    lands in docs/storybook/.
// 4. axe scans the same DOM state. Any violation, and any story that throws,
//    fails the run after every story has been tried.
//
// The lefthook pre-push job and the CI job both call this script. It does not
// use Storybook's test-runner (rules/storybook.md).

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium } from '@playwright/test';
import { logoAnswer } from './storybook-logo-route';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web');
const OUT_DIR = path.join(ROOT, 'docs', 'storybook');
const VIEWPORT = { width: 1280, height: 800 };
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
  const state = (window.__storyState = { done: false, error: null });
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
  const browser = await chromium.launch();
  const failures: string[] = [];
  let shot = 0;
  try {
    const stories = await waitForIndex(base);
    const context = await browser.newContext({
      viewport: VIEWPORT,
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

    for (const { id } of stories.filter((s) => !only || s.id.includes(only))) {
      console.log(`- ${id}`);
      const page = await context.newPage();
      try {
        await page.goto(`${base}/iframe.html?id=${id}&viewMode=story`);
        await page.waitForSelector('#storybook-root', {
          state: 'attached',
          timeout: STORY_TIMEOUT_MS,
        });
        await page.waitForFunction(
          // biome-ignore lint/suspicious/noExplicitAny: runs in the page
          () => (window as any).__storyState?.done === true,
          undefined,
          { timeout: STORY_TIMEOUT_MS },
        );
        const error = await page.evaluate(
          // biome-ignore lint/suspicious/noExplicitAny: runs in the page
          () => (window as any).__storyState.error as string | null,
        );
        if (error) {
          failures.push(`${id}: the story threw: ${error}`);
          continue;
        }
        await page.addStyleTag({ content: QUIET });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: path.join(OUT_DIR, `${id}.png`) });
        shot++;

        const { violations } = await new AxeBuilder({ page })
          .withTags(TAGS)
          .analyze();
        for (const v of violations)
          failures.push(
            `${id}: axe ${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
          );
      } catch (err) {
        failures.push(`${id}: ${err instanceof Error ? err.message : err}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
    if (!given) await rm(staticDir, { recursive: true, force: true });
  }

  console.log(`saved ${shot} screenshots to ${path.relative(ROOT, OUT_DIR)}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} problem(s):\n`);
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
}

await main();
