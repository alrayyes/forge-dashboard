/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { avatarSrc, FAILED_IMAGE_MS, noteImageFailed } from './avatar';
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

// A refused image carries no cache header, so a redrawn row would ask again
// and show an empty box until it failed again (#5124).
describe('a failed image', () => {
  const url = 'https://avatars.githubusercontent.com/u/5124';
  const src = proxied('github', url);

  test('is left alone for a while, then tried again', () => {
    noteImageFailed(src, 1000);
    expect(avatarSrc('github', url, 1000)).toBeNull();
    expect(avatarSrc('github', url, 999 + FAILED_IMAGE_MS)).toBeNull();
    expect(avatarSrc('github', url, 1000 + FAILED_IMAGE_MS)).toBe(src);
  });

  test('leaves other images alone', () => {
    noteImageFailed(src, 1000);
    const other = 'https://avatars.githubusercontent.com/u/1';
    expect(avatarSrc('github', other, 1000)).toBe(proxied('github', other));
  });
});
