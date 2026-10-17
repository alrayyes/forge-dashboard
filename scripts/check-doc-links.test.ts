import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkDocLinks, slug } from './check-doc-links';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// Builds a throwaway repo from {path: contents} and returns the problems
// checkDocLinks reports as "file:line: target" strings.
function run(files: Record<string, string>): string[] {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-links-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return checkDocLinks(root).map((f) => `${f.file}:${f.line}: ${f.target}`);
}

test('a link to a file that exists passes, one that does not fails', () => {
  expect(
    run({
      'README.md': '[ok](docs/a.md)\n[bad](docs/missing.md)\n',
      'docs/a.md': '# A\n',
    }),
  ).toEqual(['README.md:2: docs/missing.md']);
});

test('file names are matched case-sensitively', () => {
  expect(
    run({ 'README.md': '[x](docs/A.md)\n', 'docs/a.md': '# A\n' }),
  ).toEqual(['README.md:1: docs/A.md']);
});

test('links resolve relative to the file that holds them', () => {
  expect(
    run({
      'docs/a.md': '[up](../README.md)\n[sib](b.md)\n[bad](../b.md)\n',
      'docs/b.md': '# B\n',
      'README.md': '# R\n',
    }),
  ).toEqual(['docs/a.md:3: ../b.md']);
});

test('an absolute-path link resolves from the repo root', () => {
  expect(
    run({
      'docs/a.md': '[ok](/README.md)\n[bad](/nope.md)\n',
      'README.md': '# R\n',
    }),
  ).toEqual(['docs/a.md:2: /nope.md']);
});

test('a same-file anchor must match a heading', () => {
  expect(
    run({ 'README.md': '# Title\n\n## Run it\n\n[a](#run-it)\n[b](#run)\n' }),
  ).toEqual(['README.md:6: #run']);
});

test('a cross-file anchor must match a heading in the target', () => {
  expect(
    run({
      'README.md': '[a](docs/a.md#setup)\n[b](docs/a.md#teardown)\n',
      'docs/a.md': '# A\n\n## Setup\n',
    }),
  ).toEqual(['README.md:2: docs/a.md#teardown']);
});

test('renaming a heading breaks the anchors that point at it', () => {
  const link = '[a](docs/a.md#setup)\n';
  expect(run({ 'README.md': link, 'docs/a.md': '## Setup\n' })).toEqual([]);
  expect(run({ 'README.md': link, 'docs/a.md': '## Set up\n' })).toEqual([
    'README.md:1: docs/a.md#setup',
  ]);
});

test('duplicate headings get -1, -2 suffixes', () => {
  const doc = '# Notes\n\n## Usage\n\n## Usage\n\n## Usage\n';
  expect(
    run({
      'README.md':
        '[1](a.md#usage)\n[2](a.md#usage-1)\n[3](a.md#usage-2)\n[4](a.md#usage-3)\n',
      'a.md': doc,
    }),
  ).toEqual(['README.md:4: a.md#usage-3']);
});

test('slugs follow GitHub: lowercase, drop punctuation, spaces to hyphens', () => {
  expect(slug('Pull request actions')).toBe('pull-request-actions');
  expect(slug('What’s `new` in v1.2?')).toBe('whats-new-in-v12');
  expect(slug('Auth & credentials')).toBe('auth--credentials');
  expect(slug('snake_case stays')).toBe('snake_case-stays');
  expect(slug('A [link](x.md) here')).toBe('a-link-here');
  expect(slug('Bold **word**')).toBe('bold-word');
});

test('an image link must point at a file that exists', () => {
  expect(
    run({
      'README.md': '![ok](docs/s.png)\n![bad](docs/gone.png)\n',
      'docs/s.png': 'x',
    }),
  ).toEqual(['README.md:2: docs/gone.png']);
});

test('an image inside a link is checked too', () => {
  expect(
    run({ 'README.md': '[![alt](gone.png)](https://example.com)\n' }),
  ).toEqual(['README.md:1: gone.png']);
});

test('links inside code fences and inline code are ignored', () => {
  expect(
    run({
      'README.md':
        '```md\n[x](nope.md)\n# Fake heading\n```\n`[y](nope.md)`\n[z](#fake-heading)\n',
    }),
  ).toEqual(['README.md:6: #fake-heading']);
});

test('html tags are fine, and their href and src are checked', () => {
  expect(
    run({
      'README.md':
        '<details>\n<summary>More</summary>\n\n## Inside\n\n[a](#inside)\n</details>\n<a href="gone.md">x</a>\n<img src="s.png">\n',
      's.png': 'x',
    }),
  ).toEqual(['README.md:8: gone.md']);
});

test('an explicit html anchor satisfies a fragment', () => {
  expect(run({ 'README.md': '<a id="here"></a>\n\n[a](#here)\n' })).toEqual([]);
});

test('external and mail links are not fetched or checked', () => {
  expect(
    run({
      'README.md':
        '[a](https://example.com/x#y)\n[b](mailto:a@b.c)\n[c](http://localhost:8080/nope)\n',
    }),
  ).toEqual([]);
});

test('reference-style definitions are checked', () => {
  expect(
    run({ 'README.md': '[a][r]\n\n[r]: gone.md\n[s]: https://example.com\n' }),
  ).toEqual(['README.md:3: gone.md']);
});

test('titles, angle brackets and query strings do not confuse it', () => {
  expect(
    run({
      'README.md': '[a](a.md "title")\n[b](<a.md>)\n[c](a.md?plain=1#top)\n',
      'a.md': '# Top\n',
    }),
  ).toEqual([]);
});

test('a link to a directory passes', () => {
  expect(run({ 'README.md': '[d](docs/)\n', 'docs/a.md': '# A\n' })).toEqual(
    [],
  );
});

test('every Markdown page under docs/ is scanned', () => {
  expect(
    run({ 'docs/deep/er/a.md': '[x](gone.md)\n', 'README.md': '# R\n' }),
  ).toEqual(['docs/deep/er/a.md:1: gone.md']);
});

test('CHANGELOG.md is not scanned', () => {
  expect(
    run({ 'CHANGELOG.md': '[x](gone.md)\n', 'README.md': '# R\n' }),
  ).toEqual([]);
});

test('a link that climbs out of the repo is a forge URL, not a file', () => {
  expect(
    run({ 'SECURITY.md': '[r](../../security/advisories/new)\n' }),
  ).toEqual([]);
});
