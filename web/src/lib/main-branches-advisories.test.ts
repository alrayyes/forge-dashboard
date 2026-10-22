/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  type Advisories,
  advisoryCoverage,
  advisoryPill,
  type MainBranch,
} from './main-branches';

const URL = 'https://example.com/acme/x/security/dependabot';

describe('advisoryPill', () => {
  test('no field draws no pill', () => {
    expect(advisoryPill(undefined)).toBeNull();
  });

  test('a known zero draws no pill, so nothing alarms', () => {
    expect(advisoryPill({ state: 'known', count: 0 })).toBeNull();
  });

  test('unknown draws no pill: the page says it once instead', () => {
    expect(advisoryPill({ state: 'unknown', count: 0 })).toBeNull();
  });

  test('a count and severity read as words, linking to the url', () => {
    expect(
      advisoryPill({ state: 'known', count: 3, highest: 'high', url: URL }),
    ).toEqual({
      tone: 'high',
      text: '3 advisories, high',
      href: URL,
    });
  });

  test('one advisory is singular', () => {
    expect(
      advisoryPill({ state: 'known', count: 1, highest: 'low', url: URL })
        ?.text,
    ).toBe('1 advisory, low');
  });

  test('a missing severity still shows the count', () => {
    const pill = advisoryPill({ state: 'known', count: 2, url: URL });
    expect(pill?.text).toBe('2 advisories');
    expect(pill?.tone).toBe('counted');
  });

  test('a url that is not http(s) is not linked', () => {
    expect(
      advisoryPill({
        state: 'known',
        count: 2,
        highest: 'critical',
        url: 'javascript:alert(1)',
      })?.href,
    ).toBeNull();
  });
});

const b = (advisories?: Advisories) => ({ advisories }) as MainBranch;
const unknown: Advisories = { state: 'unknown', count: 0 };
const known: Advisories = { state: 'known', count: 0 };

describe('advisoryCoverage', () => {
  test('every row that has an answer is unknown: one notice', () => {
    expect(advisoryCoverage([b(unknown), b(unknown), b()])).toBe('none');
  });

  test('some known, some unknown: a quiet cue on the unknown rows', () => {
    expect(advisoryCoverage([b(unknown), b(known)])).toBe('partial');
  });

  test('all known, or no source at all, has nothing to say', () => {
    expect(advisoryCoverage([b(known), b()])).toBe('full');
    expect(advisoryCoverage([b(), b()])).toBe('full');
    expect(advisoryCoverage([])).toBe('full');
  });
});
