/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { avatarSrc } from './avatar';

// The forge's avatar URL is passed through unchanged, but only https is
// loaded: anything else shows the fallback.

describe('avatarSrc', () => {
  test('keeps an https URL as it is', () => {
    expect(avatarSrc('https://avatars.example.com/u/1?s=64')).toBe(
      'https://avatars.example.com/u/1?s=64',
    );
  });

  test.each([
    ['http', 'http://avatars.example.com/u/1'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:image/png;base64,AAAA'],
    ['not a URL', 'not a url'],
    ['empty', ''],
  ])('refuses %s', (_name, url) => {
    expect(avatarSrc(url)).toBeNull();
  });

  test('refuses a missing URL', () => {
    expect(avatarSrc(undefined)).toBeNull();
  });
});
