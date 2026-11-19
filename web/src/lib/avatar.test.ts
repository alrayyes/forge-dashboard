/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { avatarSrc } from './avatar';
import { registerImagePolicy } from './forges';

// An avatar or logo is the forge's own https URL, but the page never loads it
// from there: it asks the image proxy, so the Content-Security-Policy can
// name this server alone (#3467). The server holds the host lists and is the
// one that enforces them.

const proxied = (forge: string, url: string) =>
  `/api/v1/images?forge=${forge}&url=${encodeURIComponent(url)}&kind=avatar`;

describe('avatarSrc', () => {
  test('names the forge of the row the image belongs to, whatever the host', () => {
    const url = 'https://avatars.githubusercontent.com/u/1?v=4';
    expect(avatarSrc('github', url)).toBe(proxied('github', url));
    expect(avatarSrc('forgejo', url)).toBe(proxied('forgejo', url));
    const other = 'https://git.example/avatars/abc?size=64';
    expect(avatarSrc('forgejo', other)).toBe(proxied('forgejo', other));
    expect(avatarSrc('github', other)).toBe(proxied('github', other));
  });

  test('follows a forge registered with an image policy, with no other edit', () => {
    registerImagePolicy('thirdforge', { hosts: [] });
    const url = 'https://third.example/a.png';
    expect(avatarSrc('thirdforge', url)).toBe(proxied('thirdforge', url));
  });

  test('refuses a forge nobody described', () => {
    expect(avatarSrc('mystery', 'https://x.example/a.png')).toBeNull();
    expect(avatarSrc('constructor', 'https://x.example/a.png')).toBeNull();
  });

  test.each([
    ['http', 'http://avatars.example.com/u/1'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:image/png;base64,AAAA'],
    ['not a URL', 'not a url'],
    ['empty', ''],
  ])('refuses %s', (_name, url) => {
    expect(avatarSrc('github', url)).toBeNull();
  });

  test('refuses a user-info trick', () => {
    expect(
      avatarSrc(
        'github',
        'https://avatars.githubusercontent.com@evil.test/a.png',
      ),
    ).toBeNull();
  });

  test('refuses a missing URL', () => {
    expect(avatarSrc('github', undefined)).toBeNull();
  });
});
