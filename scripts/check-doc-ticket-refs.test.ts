import { expect, test } from 'bun:test';
import { findTicketRefs } from './check-doc-ticket-refs';

const found = (md: string) => findTicketRefs(md).map((f) => f.match);

test('flags a bare ticket number with its line', () => {
  expect(findTicketRefs('one\ntwo (#1503)')).toEqual([
    { line: 2, match: '#1503' },
  ]);
});

test('flags owner/repo#n, own issue and pull links, and the forge', () => {
  expect(found('see alrayyes/forge-dashboard#9')).toEqual([
    'alrayyes/forge-dashboard#9',
  ]);
  expect(
    found('[x](https://github.com/alrayyes/forge-dashboard/issues/746)'),
  ).toEqual(['github.com/alrayyes/forge-dashboard/issues/746']);
  expect(
    found('https://github.com/alrayyes/forge-dashboard/pull/12'),
  ).toHaveLength(1);
  expect(found('https://git.higherlearning.eu/x/y')).toEqual([
    'git.higherlearning.eu',
  ]);
});

test('lets code through: inline spans and fenced blocks', () => {
  expect(found('says `Hid PR #123` once')).toEqual([]);
  expect(found('```text\nHid PR #123\n```\nafter')).toEqual([]);
  expect(found('~~~\n#5\n~~~')).toEqual([]);
  expect(found('a `span\nacross` lines #7')).toEqual(['#7']);
});

test('lets a third party’s tracker through, full URL only', () => {
  const md =
    '[upstream issue](https://github.com/dependabot/dependabot-core/issues/9147)';
  expect(found(md)).toEqual([]);
  expect(found('https://example.com/page#12')).toEqual([]);
});

test('ignores entities, headings and colour codes without a hash digit run', () => {
  expect(found('it&#39;s # Heading and issue-1')).toEqual([]);
});
