/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writesForgeEntryByHand } from './forge-entries-by-hand';

// Every mocked `forges` entry comes from forgeHealth() (#4030), so `capabilities`
// is filled in one place. The list shrinks to empty as the specs convert
// (#4030), and a new hand-written entry in any file fails this test.
const stillByHand: string[] = [
  'branch-rerun-checks.spec.ts',
  'nav-count-reads.spec.ts',
  'shared-dashboard-read.spec.ts',
];

const dir = join(import.meta.dir, '..', 'tests');

const writtenByHand = readdirSync(dir)
  .filter((name) => name.endsWith('.ts') && name !== 'forge-health-helper.ts')
  .filter((name) =>
    writesForgeEntryByHand(readFileSync(join(dir, name), 'utf8')),
  )
  .sort();

test('no spec writes a forge entry by hand unless it is on the list (#4030)', () => {
  const added = writtenByHand.filter((name) => !stillByHand.includes(name));
  // Build the entry with forgeHealth() from tests/forge-health-helper.ts, which
  // fills `capabilities`. Do not add the file to the list above.
  expect(
    added,
    'build each forge entry with forgeHealth() from tests/forge-health-helper.ts instead of adding the file to stillByHand',
  ).toEqual([]);
});

test.each([
  ['plain', "{ forge: 'github', reachable: true, repoCount: 1 }"],
  ['reachable first', "{ reachable: true, forge: 'github' }"],
  ['leading spread', "{ ...base, forge: 'github', reachable: true }"],
  ['key between', "{ forge: 'github', repoCount: 1, reachable: true }"],
  ['quoted keys', "{ 'forge': 'github', \"reachable\": true }"],
  ['space before colon', "{ forge : 'github', reachable : true }"],
  ['shorthand', '{ forge, reachable: true, repoCount: 1 }'],
  ['no reachable key (#4030)', "{ forge: 'github', repoCount: 1 }"],
  ['repoCount with a spread', "{ forge: 'github', repoCount: 3, ...health }"],
  ['repoCount shorthand', '{ forge, repoCount }'],
  ['multi-line', "{\n  forge: 'github',\n  reachable: true,\n}"],
  ['inside a list', 'forges: [{ forge: pr.forge, reachable: true }]'],
  [
    'after a regex literal holding a quote (#4443)',
    "const r = /'/; x = { forge: 'a', reachable: true }",
  ],
  [
    'inside a template substitution (#4443)',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test
    'const s = `a ${{ forge: 1, reachable: true }} b`;',
  ],
])('the detector catches a hand-written entry: %s (#4030)', (_name, source) => {
  expect(writesForgeEntryByHand(source)).toBe(true);
});

test.each([
  ['forgeHealth call', "forgeHealth('github', { reachable: false })"],
  ['forge only', "{ forge: 'github' }"],
  ['a repo row has no repoCount', "{ forge: 'github', fullName: 'a/b' }"],
  ['keys on different objects', "{ a: { forge: 'x' }, reachable: true }"],
  [
    'a call inside nested blocks is not an entry (#4030)',
    "describe(() => { test(() => { f(forgeHealth('github', { repoCount: 3 })); }); });",
  ],
  ['text, not keys', "const forgeName = 'reachable';"],
  [
    'words in a string inside a block',
    "async () => { const title = 'the forge is reachable now'; await go(); }",
  ],
  [
    'words in multi-line template text (#4443)',
    'const t = `\n  { forge: 1, reachable: 2 }\n`; const o = { a: 1 };',
  ],
  [
    'words in a line comment with an apostrophe (#4443)',
    "// it's { forge: 1, reachable: 2 }\nconst x = 'y';",
  ],
  [
    'words in a block comment (#4443)',
    '/* { forge: 1, reachable: true } */ const x = { a: 1 };',
  ],
  [
    'words in a regex literal (#4443)',
    'const o = { a: / forge, reachable, / };',
  ],
  [
    'a division is not a regex (#4443)',
    'const q = a / b; const o = { forge: 1 }; const z = c / d;',
  ],
])('the detector leaves alone: %s (#4030)', (_name, source) => {
  expect(writesForgeEntryByHand(source)).toBe(false);
});

test('a spec on the list still writes one, so the list shrinks as they convert (#4030)', () => {
  expect(stillByHand.filter((name) => !writtenByHand.includes(name))).toEqual(
    [],
  );
});
