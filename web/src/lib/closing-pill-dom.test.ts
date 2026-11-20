/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type ClosingIssue,
  closingDialogName,
  closingPills,
} from './closing-issues';

// A closing or refs pill in a dialog for an issue in a repository the
// dashboard does not track links to the forge in a new tab, so a click leaves
// the dialog open (#4461). `bun test` has no DOM, so the nodes are small fakes
// that hold only what the pill-building code reads. The page wiring is
// foreign-relation-pill.spec.ts.

class FakeNode {
  children: (FakeNode | string)[] = [];
  className = '';
  title = '';
  href = '';
  target = '';
  rel = '';
  attrs: Record<string, string> = {};
  listeners: Record<string, (event?: unknown) => void> = {};
  classList = { add: () => {}, contains: () => false };
  constructor(readonly tag: string) {}
  set textContent(text: string) {
    this.children = [text];
  }
  append(...nodes: (FakeNode | string)[]) {
    this.children.push(...nodes);
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  addEventListener(name: string, fn: (event?: unknown) => void) {
    this.listeners[name] = fn;
  }
}
class FakeAnchor extends FakeNode {}
class FakeButton extends FakeNode {
  type = '';
  id = '';
}

const g = globalThis as Record<string, unknown>;
const saved = {
  document: g.document,
  HTMLAnchorElement: g.HTMLAnchorElement,
  HTMLButtonElement: g.HTMLButtonElement,
  HTMLElement: g.HTMLElement,
};
beforeAll(() => {
  g.document = {
    createElement: (tag: string) =>
      tag === 'a'
        ? new FakeAnchor(tag)
        : tag === 'button'
          ? new FakeButton(tag)
          : new FakeNode(tag),
  };
  g.HTMLAnchorElement = FakeAnchor;
  g.HTMLButtonElement = FakeButton;
  g.HTMLElement = FakeNode;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v;
});

const issue = (over: Partial<ClosingIssue> = {}): ClosingIssue => ({
  repo: 'alrayyes/other',
  number: 12,
  url: 'https://example.com/alrayyes/other/issues/12',
  pageUrl: '/issues.html?issue=github/alrayyes/other/12',
  ...over,
});
const untracked = (repo: string) => repo === 'alrayyes/other';

const pillOf = (
  i: ClosingIssue,
  inDialog: boolean,
  foreign: ((repo: string) => boolean) | undefined,
) => {
  const wrap = closingPills(
    'k',
    'alrayyes/app',
    [i],
    undefined,
    () => {},
    inDialog,
    foreign,
  ) as unknown as FakeNode;
  return wrap.children[0] as FakeAnchor;
};

describe('a closing pill in a dialog for an untracked repository', () => {
  test('links to the forge in a new tab and says so in its name', () => {
    const pill = pillOf(issue(), true, untracked);
    expect(pill.href).toBe('https://example.com/alrayyes/other/issues/12');
    expect(pill.target).toBe('_blank');
    expect(pill.rel).toBe('noopener noreferrer');
    expect(pill.attrs['aria-label']).toBe(
      'Closes: alrayyes/other#12, opens on the forge in a new tab',
    );
  });

  test('does not hand a plain click to the dialog', () => {
    expect(Object.keys(pillOf(issue(), true, untracked).listeners)).toEqual([]);
  });

  test('a tracked repository keeps the page address and the follow', () => {
    const pill = pillOf(issue({ repo: 'alrayyes/app' }), true, untracked);
    expect(pill.href).toBe('/issues.html?issue=github/alrayyes/other/12');
    expect(pill.target).toBe('');
    expect(Object.keys(pill.listeners)).toEqual(['click']);
    expect(pill.attrs['aria-label']).toBe('Closes: #12, opens the issue');
  });

  test('no predicate leaves every pill as it was', () => {
    const pill = pillOf(issue(), true, undefined);
    expect(pill.target).toBe('');
    expect(Object.keys(pill.listeners)).toEqual(['click']);
  });

  test('a row outside a dialog is left as it is', () => {
    const pill = pillOf(issue(), false, untracked);
    expect(pill.target).toBe('');
    expect(pill.href).toBe('/issues.html?issue=github/alrayyes/other/12');
    expect(pill.attrs['aria-label']).toBe(
      'Closes alrayyes/other#12, opens the issue',
    );
  });
});

describe('closingDialogName for an external pill', () => {
  test('says where the pill goes, for a close and for a ref', () => {
    expect(closingDialogName(issue(), 'alrayyes/app', true)).toBe(
      'Closes: alrayyes/other#12, opens on the forge in a new tab',
    );
    expect(
      closingDialogName(issue({ relation: 'refs' }), 'alrayyes/app', true),
    ).toBe(
      'Refs: alrayyes/other#12, does not close, opens on the forge in a new tab',
    );
    expect(closingDialogName(issue(), 'alrayyes/app')).toBe(
      'Closes: alrayyes/other#12, opens the issue',
    );
  });
});
