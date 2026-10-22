/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { advisoryPill } from './main-branches';

const URL = 'https://example.com/acme/x/security/dependabot';

describe('advisoryPill', () => {
  test('no field draws no pill', () => {
    expect(advisoryPill(undefined)).toBeNull();
  });

  test('a known zero draws no pill, so nothing alarms', () => {
    expect(advisoryPill({ state: 'known', count: 0 })).toBeNull();
  });

  test('unknown says unknown, never zero, and carries no link', () => {
    const pill = advisoryPill({ state: 'unknown', count: 0 });
    expect(pill).toEqual({
      tone: 'unknown',
      text: 'Advisories unknown',
      label: 'Dependency advisories unknown',
      href: null,
    });
  });

  test('a count and severity read as words, linking to the url', () => {
    expect(
      advisoryPill({ state: 'known', count: 3, highest: 'high', url: URL }),
    ).toEqual({
      tone: 'high',
      text: '3 advisories, high',
      label: '3 open dependency advisories, highest severity high',
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
