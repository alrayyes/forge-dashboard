/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { registerImagePolicy, resetForgeCapabilities } from './forges';
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
      'https://gist.githubusercontent.com/octo/0123/raw/4567/a.png',
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
      'https://gist.github.com/octo/0123/raw/a.png',
      'https://gist.githubusercontent.com.evil.example/a.png',
      'https://evilgist.githubusercontent.com/a.png',
      'https://gist.githubusercontent.com:8443/a.png',
      'http://gist.githubusercontent.com/a.png',
    ]) {
      expect(src(url)).toBeNull();
    }
  });
});

describe('imageSourceFor with the item named', () => {
  const attachment = 'https://github.com/user-attachments/assets/1234';
  const enc = encodeURIComponent(attachment);

  test('adds an issue or pull request to a GitHub attachment', () => {
    const src = imageSourceFor('github', 'https://github.com/o/r', {
      fullName: 'o/r',
      number: 7,
    });
    expect(src(attachment)).toBe(
      `/api/v1/images?forge=github&url=${enc}&fullName=o%2Fr&number=7`,
    );
  });

  test('names the comment an attachment sits in, ahead of the item', () => {
    const src = imageSourceFor('github', 'https://github.com/o/r', {
      fullName: 'o/r',
      number: 7,
      comment: '4242',
    });
    expect(src(attachment)).toBe(
      `/api/v1/images?forge=github&url=${enc}&fullName=o%2Fr&comment=4242`,
    );
  });

  test('sends no comment for an address that is not an attachment', () => {
    const src = imageSourceFor('github', 'https://github.com/o/r', {
      fullName: 'o/r',
      number: 7,
      comment: '4242',
    });
    const other = 'https://user-images.githubusercontent.com/1/a.png';
    expect(src(other)).toBe(proxied('github', other));
  });

  test('adds a release by its tag', () => {
    const src = imageSourceFor('github', 'https://github.com/o/r', {
      fullName: 'o/r',
      tag: 'v1.0.0',
    });
    expect(src(attachment)).toBe(
      `/api/v1/images?forge=github&url=${enc}&fullName=o%2Fr&tag=v1.0.0`,
    );
  });

  test('leaves every other address as it was', () => {
    const src = imageSourceFor('github', 'https://github.com/o/r', {
      fullName: 'o/r',
      number: 7,
    });
    const other = 'https://user-images.githubusercontent.com/1/a.png';
    expect(src(other)).toBe(proxied('github', other));
  });
});

test('an item with no repository address gets no images', () => {
  expect(
    imageSourceFor('forgejo', null)('https://git.example/a.png'),
  ).toBeNull();
});

// The host policy is the forge's, not image-source.ts's: a forge added to the
// capability table follows it with no edit to the image path (#4156).
describe('imageSourceFor a forge with its own policy', () => {
  afterEach(resetForgeCapabilities);

  test('allows exactly the hosts the forge names, over https', () => {
    registerImagePolicy('gitea', { hosts: ['cdn.gitea.test'] });
    const src = imageSourceFor('gitea', 'https://git.example/o/r');
    const url = 'https://cdn.gitea.test/a.png';
    expect(src(url)).toBe(proxied('gitea', url));
    expect(src('https://git.example/a.png')).toBeNull();
    expect(src('http://cdn.gitea.test/a.png')).toBeNull();
    expect(src('https://cdn.gitea.test:8443/a.png')).toBeNull();
  });

  test("allows the item's own origin when the forge names no hosts", () => {
    registerImagePolicy('gitea', { hosts: [] });
    const src = imageSourceFor('gitea', 'https://git.example/o/r');
    const url = 'https://git.example/attachments/abc';
    expect(src(url)).toBe(proxied('gitea', url));
    expect(src('https://other.test/a.png')).toBeNull();
  });

  test('names the item only where the forge signs attachments', () => {
    registerImagePolicy('gitea', {
      hosts: ['files.gitea.test'],
      signedAttachmentPrefix: 'https://files.gitea.test/att/',
    });
    const src = imageSourceFor('gitea', null, { fullName: 'o/r', number: 7 });
    const att = 'https://files.gitea.test/att/1';
    expect(src(att)).toBe(`${proxied('gitea', att)}&fullName=o%2Fr&number=7`);
    const plain = 'https://files.gitea.test/other/1';
    expect(src(plain)).toBe(proxied('gitea', plain));
  });

  test('knows nothing of an unregistered forge', () => {
    expect(
      imageSourceFor(
        'gitea',
        'https://git.example',
      )('https://git.example/a.png'),
    ).toBeNull();
  });
});
