/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type MentionedIssue, mentionPills } from './mentioned-issues';

// What a pill for an item the dashboard does not hold listens for (#5089).
// `bun test` has no DOM, so the nodes are small fakes that hold only what the
// pill-building code reads. The page wiring is mentioned-tickets.spec.ts.

class FakeNode {
  children: (FakeNode | string)[] = [];
  className = '';
  href = '';
  target = '';
  rel = '';
  listeners: Record<string, (event?: unknown) => void> = {};
  set textContent(text: string) {
    this.children = [text];
  }
  append(...nodes: (FakeNode | string)[]) {
    this.children.push(...nodes);
  }
  setAttribute() {}
  // Whether focus is the kind a keyboard gives.
  keyboardFocus = false;
  matches() {
    return this.keyboardFocus;
  }
  addEventListener(name: string, fn: (event?: unknown) => void) {
    this.listeners[name] = fn;
  }
}

const g = globalThis as Record<string, unknown>;
const savedDocument = g.document;
beforeAll(() => {
  g.document = { createElement: () => new FakeNode() };
});
afterAll(() => {
  g.document = savedDocument;
});

const gone: MentionedIssue = {
  repo: 'alrayyes/app',
  number: 4,
  url: 'https://example.com/alrayyes/app/issues/4',
  pageUrl: '/issues.html?issue=github/alrayyes/app/4',
  tracked: false,
};

function build(repoTracked: boolean, answered: boolean) {
  const opened: number[] = [];
  const warmed: number[] = [];
  const wrap = mentionPills('k', 'alrayyes/app', [gone], undefined, true, {
    repoTracked: () => repoTracked,
    warm: (issue) => {
      warmed.push(issue.number);
    },
    open: (issue) => {
      opened.push(issue.number);
      return answered;
    },
  }) as unknown as FakeNode;
  return { pill: wrap.children[0] as FakeNode, opened, warmed };
}

function click(pill: FakeNode, over: Record<string, unknown> = {}) {
  let prevented = false;
  pill.listeners.click({
    button: 0,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: () => {
      prevented = true;
    },
    ...over,
  });
  return prevented;
}

describe('an unlisted item of a tracked repository', () => {
  // The dialog reads the item itself, so a second read for the press that
  // opens it would be wasted.
  test('a press or a tap asks nothing ahead of the dialog', () => {
    const { pill, warmed } = build(true, true);
    expect(pill.listeners.pointerdown).toBeUndefined();
    pill.listeners.focus();
    expect(warmed).toEqual([]);
  });

  test('keyboard focus warms it, so the dialog opens already filled', () => {
    const { pill, warmed } = build(true, true);
    pill.keyboardFocus = true;
    pill.listeners.focus();
    expect(warmed).toEqual([4]);
  });

  test('a resting pointer still warms it', () => {
    expect(build(true, true).pill.listeners.pointerover).toBeDefined();
  });

  test('a plain click opens the dialog instead of following the link', () => {
    const { pill, opened } = build(true, true);
    expect(click(pill)).toBe(true);
    expect(opened).toEqual([4]);
  });

  test('a modified or middle click follows the link to the forge', () => {
    const { pill, opened } = build(true, true);
    for (const over of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { button: 1 },
    ])
      expect(click(pill, over)).toBe(false);
    expect(opened).toEqual([]);
    expect(pill.href).toBe(gone.url);
    expect(pill.target).toBe('_blank');
  });
});

describe('an item of an untracked repository', () => {
  test('is still warmed on rest, press and focus', () => {
    expect(
      Object.keys(build(false, false).pill.listeners).sort((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual(['click', 'focus', 'pointerdown', 'pointerout', 'pointerover']);
  });

  test('warms on a press and on any focus', () => {
    const { pill, warmed } = build(false, false);
    pill.listeners.pointerdown();
    pill.listeners.focus();
    expect(warmed).toEqual([4, 4]);
  });

  test('follows the link while the forge has not answered', () => {
    expect(click(build(false, false).pill)).toBe(false);
  });
});
