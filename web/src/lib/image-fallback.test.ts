/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { imageFallback } from './image-fallback';

// https://github.com/alrayyes/forge-dashboard/issues/3835
// `bun test` has no DOM, so the container and its images are small fakes that
// hold only what the action reads.
class FakeImage {
  classes = new Set(['md-image']);
  classList = {
    add: (name: string) => this.classes.add(name),
    contains: (name: string) => this.classes.has(name),
  };
  constructor(
    public complete: boolean,
    public naturalWidth: number,
  ) {}
}

function container(images: FakeImage[]) {
  return {
    querySelectorAll: () => images,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLElement;
}

const realObserver = globalThis.MutationObserver;
beforeEach(() => {
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof MutationObserver;
});
afterEach(() => {
  globalThis.MutationObserver = realObserver;
});

describe('imageFallback on attach', () => {
  test('marks an image that is already complete as loaded', () => {
    const cached = new FakeImage(true, 400);
    imageFallback(container([cached])).destroy();
    expect(cached.classes.has('md-image-loaded')).toBe(true);
  });

  test('leaves an image that is still loading alone', () => {
    const pending = new FakeImage(false, 0);
    imageFallback(container([pending])).destroy();
    expect(pending.classes.has('md-image-loaded')).toBe(false);
  });

  test('leaves a complete but broken image (no width) alone', () => {
    const broken = new FakeImage(true, 0);
    imageFallback(container([broken])).destroy();
    expect(broken.classes.has('md-image-loaded')).toBe(false);
  });
});
