import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-links-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

function run(files: Record<string, string>): string[] {
  const root = fixture(files);
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

test('a heading with inline code keeps the code text in its anchor', () => {
  expect(slug('The `foo` flag')).toBe('the-foo-flag');
  expect(slug('`CI_POLL_INTERVAL`')).toBe('ci_poll_interval');
  expect(slug('Set `FOO_BAR` for _real_ runs')).toBe(
    'set-foo_bar-for-real-runs',
  );
  expect(
    run({
      'README.md':
        '## The `foo` flag\n\n## `CI_POLL_INTERVAL`\n\n[a](#the-foo-flag)\n[b](#ci_poll_interval)\n[c](#foo)\n',
    }),
  ).toEqual(['README.md:7: #foo']);
});

test('emphasis markers leave the slug, underscores inside words stay', () => {
  expect(slug('An _emph_ word')).toBe('an-emph-word');
  expect(slug('A *star* and **bold** word')).toBe('a-star-and-bold-word');
  expect(slug('snake_case name')).toBe('snake_case-name');
  expect(slug('Trailing _under_')).toBe('trailing-under');
});

test('footnote definitions are not reference definitions', () => {
  expect(run({ 'README.md': 'Text[^1]\n\n[^1]: a note\n' })).toEqual([]);
});

test('setext headings are headings', () => {
  expect(
    run({
      'README.md':
        'Title\n=====\n\nSub section\n-----------\n\n[a](#title)\n[b](#sub-section)\n[c](#nope)\n',
    }),
  ).toEqual(['README.md:9: #nope']);
});

test('a horizontal rule after a blank line is not a heading', () => {
  expect(
    run({ 'README.md': '# Para\n\n---\n\n[a](#para)\n[b](#para-1)\n' }),
  ).toEqual(['README.md:6: #para-1']);
});

test('parentheses inside a link destination are balanced', () => {
  expect(
    run({
      'README.md': '[a](a(1).md)\n[b](b(2).md)\n',
      'a(1).md': '# A\n',
    }),
  ).toEqual(['README.md:2: b(2).md']);
});

test('a byte-order mark does not hide the first heading', () => {
  expect(
    run({ 'README.md': '\uFEFF# Title\n\n[a](#title)\n', 'b.md': '' }),
  ).toEqual([]);
  expect(
    run({ 'README.md': '[a](b.md#top)\n', 'b.md': '\uFEFF# Top\n' }),
  ).toEqual([]);
});

const cli = (root: string) =>
  spawnSync('bun', [path.join(import.meta.dir, 'check-doc-links.ts'), root], {
    encoding: 'utf8',
  });

test('the CLI exits 1 and names the problem when a link is broken', () => {
  const r = cli(fixture({ 'README.md': '[x](gone.md)\n' }));
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('README.md:1: gone.md');
});

test('the CLI exits 0 on clean docs', () => {
  const r = cli(fixture({ 'README.md': '# T\n\n[x](#t)\n' }));
  expect(r.status).toBe(0);
  expect(r.stderr).toBe('');
});
