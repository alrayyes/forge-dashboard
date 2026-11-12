/// <reference types="bun" />
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  heldPicks,
  holdStale,
  releaseAllHeld,
  releaseHeld,
  renderHeldPicks,
  type SharedFilterState,
} from './filters';

// renderHeldPicks keeps the note's lines in step with the held picks and
// touches only the lines that changed, so a screen reader is not handed the
// others again (#1620). Just enough DOM for it: elements with children, a
// dataset, and the few calls it makes.
// https://github.com/alrayyes/forge-dashboard/issues/1620

class FakeEl {
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  textContent = '';
  className = '';
  type = '';
  listeners: Record<string, () => void> = {};
  constructor(readonly tag: string) {}
  append(...els: FakeEl[]) {
    for (const el of els) this.appendChild(el);
  }
  appendChild(el: FakeEl) {
    el.parent = this;
    this.children.push(el);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  addEventListener(name: string, fn: () => void) {
    this.listeners[name] = fn;
  }
  querySelector(tag: string): FakeEl | null {
    return this.children.find((c) => c.tag === tag) ?? null;
  }
  focus() {}
}

const realDocument = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});
beforeEach(() => releaseAllHeld());

const state = (): SharedFilterState => ({
  shared: { author: 'ryan', label: 'bug' },
  pr: {},
  issue: {},
  view: {},
});

const render = (box: FakeEl) =>
  renderHeldPicks(box as unknown as HTMLElement, () => {});

describe('renderHeldPicks', () => {
  test('clearing one pick leaves the other line untouched', () => {
    const s = state();
    holdStale(s, 'shared', 'author');
    holdStale(s, 'shared', 'label');
    const box = new FakeEl('div');
    render(box);
    const [authorLine, labelLine] = box.children;
    expect(box.children).toHaveLength(2);

    releaseHeld('shared', 'author');
    render(box);

    expect(box.children).toEqual([labelLine]);
    expect(box.children[0]).toBe(labelLine);
    expect(authorLine.parent).toBeNull();
  });

  test('a second render with nothing changed keeps every line and its text', () => {
    const s = state();
    holdStale(s, 'shared', 'author');
    const box = new FakeEl('div');
    render(box);
    const [line] = box.children;
    render(box);
    expect(box.children).toHaveLength(1);
    expect(box.children[0]).toBe(line);
    expect(line.querySelector('span')?.textContent).toBe(
      'Saved author "ryan" has no forge and is not on this page.',
    );
  });

  test('the Clear button hands its pick to the callback', () => {
    const s = state();
    holdStale(s, 'shared', 'label');
    const box = new FakeEl('div');
    const removed: unknown[] = [];
    renderHeldPicks(box as unknown as HTMLElement, (pick) =>
      removed.push(pick),
    );
    box.children[0].querySelector('button')?.listeners.click();
    expect(removed).toEqual(heldPicks());
  });
});
