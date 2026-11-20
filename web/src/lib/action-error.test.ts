/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { settledBadge } from './action-error';

// The row's settled badge (#750, #4406). `bun test` has no DOM, so the nodes
// are small fakes that hold what the badge code writes. The painted colours
// are pinned in merged-pill-contrast.test.ts and the page in
// pull-request-action-refusals.spec.ts.

class FakeNode {
  children: (FakeNode | string)[] = [];
  className = '';
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  innerHTML = '';
  constructor(readonly tag: string) {}
  set textContent(text: string) {
    this.children = [text];
  }
  get textContent(): string {
    return this.children
      .map((c) => (typeof c === 'string' ? c : c.textContent))
      .join('');
  }
  append(...nodes: (FakeNode | string)[]) {
    this.children.push(...nodes);
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
}

const saved = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
  };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = saved;
});

const badge = (state: 'merged' | 'closed') =>
  settledBadge(state) as unknown as FakeNode;

describe('settledBadge', () => {
  test('a merged badge says Merged after a merge glyph the readers skip', () => {
    const b = badge('merged');
    expect(b.className).toBe('row-settled');
    expect(b.dataset.state).toBe('merged');
    expect(b.textContent).toBe('Merged');
    const glyph = b.children[0] as FakeNode;
    expect(glyph.tag).toBe('svg');
    expect(glyph.attrs['aria-hidden']).toBe('true');
    expect(glyph.attrs.class).toContain('merged-glyph');
    expect(glyph.innerHTML).toContain('<circle');
  });

  test('a closed badge stays plain text', () => {
    const b = badge('closed');
    expect(b.dataset.state).toBe('closed');
    expect(b.children).toEqual(['Closed']);
  });
});
