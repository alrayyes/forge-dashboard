/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { imageSourceFor } from './image-source';

// https://github.com/alrayyes/forge-dashboard/issues/3405
// Which embedded images the page asks the server for. The server holds the
// same list and is the one that enforces it; this only decides what to draw.
const proxied = (forge: string, url: string) =>
  `/api/v1/images?forge=${forge}&url=${encodeURIComponent(url)}`;

describe('imageSourceFor a Forgejo item', () => {
  const src = imageSourceFor('forgejo', 'https://git.example/o/r');

  test('proxies an image on the same host', () => {
    expect(src('https://git.example/attachments/abc')).toBe(
      proxied('forgejo', 'https://git.example/attachments/abc'),
    );
  });

  test('refuses another host', () => {
    expect(src('https://example.org/a.png')).toBeNull();
    expect(src('https://git.example.evil.test/a.png')).toBeNull();
    expect(src('https://evil.test/@git.example/a.png')).toBeNull();
  });

  test('refuses a user-info trick, another scheme and another port', () => {
    expect(src('https://git.example@evil.test/a.png')).toBeNull();
    expect(src('http://git.example/a.png')).toBeNull();
    expect(src('https://git.example:8443/a.png')).toBeNull();
  });

  test('refuses a relative or odd address', () => {
    expect(src('/attachments/abc')).toBeNull();
    expect(src('//git.example/a.png')).toBeNull();
    expect(src('data:image/png;base64,AAAA')).toBeNull();
    expect(src('not a url')).toBeNull();
  });
});

describe('imageSourceFor a GitHub item', () => {
  const src = imageSourceFor('github', 'https://github.com/o/r');

  test('proxies GitHub attachments and its user-content hosts', () => {
    for (const url of [
      'https://github.com/user-attachments/assets/1234',
      'https://user-images.githubusercontent.com/1/a.png',
      'https://private-user-images.githubusercontent.com/1/a.png?jwt=x',
    ]) {
      expect(src(url)).toBe(proxied('github', url));
    }
  });

  test('refuses everything else, camo-style hosts and badges included', () => {
    for (const url of [
      'https://example.org/a.png',
      'https://img.shields.io/badge/a-b-green',
      'https://camo.githubusercontent.com/abc',
      'https://github.com.evil.test/a.png',
      'http://github.com/a.png',
    ]) {
      expect(src(url)).toBeNull();
    }
  });
});

test('an item with no repository address gets no images', () => {
  expect(
    imageSourceFor('forgejo', null)('https://git.example/a.png'),
  ).toBeNull();
});
