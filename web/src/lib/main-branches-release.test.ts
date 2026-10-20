/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { releaseHref } from './main-branches';

describe('releaseHref', () => {
  test('keeps an http or https url', () => {
    expect(releaseHref('https://example.com/a/b/releases/tag/v1')).toBe(
      'https://example.com/a/b/releases/tag/v1',
    );
    expect(releaseHref('http://forge.local/a/b')).toBe(
      'http://forge.local/a/b',
    );
  });

  test('drops anything else, so it is never rendered as a href', () => {
    for (const bad of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'data:text/html,x',
      '//example.com/x',
      '/relative',
      '',
    ]) {
      expect(releaseHref(bad), bad).toBeNull();
    }
  });
});
