/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { currentFooterLink, FOOTER_PAGES } from './footer-links';

// The footer keeps the same links in the same order on every page and marks
// the one for the page you're on, instead of dropping it. This proves which
// link is current for a path, with no browser.
// https://github.com/alrayyes/forge-dashboard/issues/1679

describe('FOOTER_PAGES', () => {
  test('names the three footer pages once, in footer order', () => {
    expect(FOOTER_PAGES.map((p) => p.key)).toEqual([
      'changelog',
      'disclaimer',
      'privacy',
    ]);
  });
});

describe('currentFooterLink', () => {
  test('is the changelog, disclaimer or privacy link on its own page', () => {
    expect(currentFooterLink('/changelog')).toBe('changelog');
    expect(currentFooterLink('/disclaimer')).toBe('disclaimer');
    expect(currentFooterLink('/privacy')).toBe('privacy');
  });

  test('also matches the .html address a hard navigation lands on', () => {
    expect(currentFooterLink('/changelog.html')).toBe('changelog');
    expect(currentFooterLink('/disclaimer.html')).toBe('disclaimer');
    expect(currentFooterLink('/privacy.html')).toBe('privacy');
  });

  test('is none on every other page', () => {
    for (const path of [
      '/',
      '/login',
      '/login.html',
      '/settings.html',
      '/insights',
      '/webhooks.html',
      '/some/crashed/address',
      '/privacy/extra',
    ]) {
      expect(currentFooterLink(path)).toBeNull();
    }
  });
});
