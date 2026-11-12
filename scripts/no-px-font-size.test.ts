import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// https://github.com/alrayyes/forge-dashboard/issues/3398
//
// Text follows the browser's default font size, so font sizes are written in
// rem (px / 16), never px. Add a path here only with a reason.
const ALLOWED: Record<string, string> = {};

const ROOT = join(import.meta.dir, '..', 'web', 'src');
const PX_FONT = /\bfont(-size)?\s*:[^;"}]*\d(\.\d+)?px/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(css|svelte|html)$/.test(name) ? [path] : [];
  });
}

test('no font size under web/src is written in px', () => {
  const offenders: string[] = [];
  for (const path of files(ROOT)) {
    const rel = relative(ROOT, path);
    if (rel in ALLOWED) continue;
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (PX_FONT.test(line))
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  expect(offenders).toEqual([]);
});
