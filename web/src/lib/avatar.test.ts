/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { avatarSrc } from './avatar';

// An avatar or logo is the forge's own https URL, but the page never loads it
// from there: it asks the image proxy, so the Content-Security-Policy can
// name this server alone (#3467). The server holds the host lists and is the
// one that enforces them.

const proxied = (forge: string, url: string) =>
  `/api/v1/images?forge=${forge}&url=${encodeURIComponent(url)}&kind=avatar`;

describe('avatarSrc', () => {
  test('sends a GitHub avatar or repository logo through the GitHub proxy', () => {
    for (const url of [
      'https://avatars.githubusercontent.com/u/1?v=4',
      'https://repository-images.githubusercontent.com/1/logo',
    ]) {
      expect(avatarSrc(url)).toBe(proxied('github', url));
    }
  });

  test('sends any other https URL through the Forgejo proxy', () => {
    const url = 'https://git.example/avatars/abc?size=64';
    expect(avatarSrc(url)).toBe(proxied('forgejo', url));
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

  test('refuses a user-info trick', () => {
    expect(
      avatarSrc('https://avatars.githubusercontent.com@evil.test/a.png'),
    ).toBeNull();
  });

  test('refuses a missing URL', () => {
    expect(avatarSrc(undefined)).toBeNull();
  });
});
