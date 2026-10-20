/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { profileHref } from './profile-link';

// The server builds each person's profile page; the page only checks it is a
// web address before making it a link. A forge on plain http is allowed (a
// self-hosted Forgejo), a script or data address is not.

describe('profileHref', () => {
  test.each([
    ['https', 'https://github.com/alice'],
    ['http', 'http://forge.local/alice'],
  ])('keeps an %s address as it is', (_name, url) => {
    expect(profileHref(url)).toBe(url);
  });

  test.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,hi'],
    ['not a URL', 'not a url'],
    ['empty', ''],
  ])('refuses %s', (_name, url) => {
    expect(profileHref(url)).toBeNull();
  });

  test('refuses a missing address', () => {
    expect(profileHref(undefined)).toBeNull();
  });
});
