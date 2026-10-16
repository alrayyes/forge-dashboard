import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The README's screenshot table and the capture script must name the same
// images (#1515): a row with no shot is a broken image after the next
// release, and a shot with no row is wasted CI time.
const root = path.join(import.meta.dir, '..');
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
const script = readFileSync(
  path.join(root, 'scripts', 'capture-screenshots.ts'),
  'utf8',
);

const linked = [
  ...readme.matchAll(/\]\(docs\/screenshots\/([a-z-]+)-(light|dark)\.png\)/g),
].map((m) => m[1]);

test('the README links a light and a dark image for each dialog shot', () => {
  for (const name of [
    'pull-request-dialog',
    'release-dialog',
    'bot-dialog',
    'pull-request-sheet',
  ]) {
    expect(linked.filter((n) => n === name)).toHaveLength(2);
  }
});

test('the capture script writes every image the README links', () => {
  for (const name of new Set(linked)) {
    expect(script).toContain(name);
  }
});

test('the pull request fixture description has a ticked and an open task', () => {
  expect(script).toContain("'- [x] ");
  expect(script).toContain("'- [ ] ");
});
