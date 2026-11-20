/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type LinkedPullRequest,
  linkedPillName,
  linkedPills,
} from './linked-pull-requests';

// The pill's accessible name for an entry that already carries its state, and
// the node-by-node split of a cross-repo name, pinned without a browser (#4314).
// `bun test` has no DOM, so the nodes are small fakes that hold only what the
// pill-building code reads. The story in RelatedBand.stories.svelte still
// covers the real rendering.
// https://github.com/alrayyes/forge-dashboard/issues/4314

class FakeNode {
  children: (FakeNode | string)[] = [];
  className = '';
  title = '';
  href = '';
  attrs: Record<string, string> = {};
  classList = { add: (c: string) => (this.className += ` ${c}`) };
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
  addEventListener() {}
}
class FakeAnchor extends FakeNode {}
class FakeButton extends FakeNode {
  type = '';
  id = '';
}

type Tree = string | { tag: string; class: string; kids: Tree[] };
const tree = (n: FakeNode | string): Tree =>
  typeof n === 'string'
    ? n
    : { tag: n.tag, class: n.className.trim(), kids: n.children.map(tree) };

const g = globalThis as Record<string, unknown>;
const saved = {
  document: g.document,
  HTMLAnchorElement: g.HTMLAnchorElement,
  HTMLButtonElement: g.HTMLButtonElement,
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
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v;
});

const pr = (overrides: Partial<LinkedPullRequest> = {}): LinkedPullRequest => ({
  forge: 'github',
  repo: 'alrayyes/app',
  number: 12,
  draft: false,
  pageUrl: '/pull-requests.html?pr=github/alrayyes/app/12',
  ci: 'none',
  checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
  awaitingWorkflowApproval: false,
  ...overrides,
});

const pillOf = (p: LinkedPullRequest) => {
  const wrap = linkedPills('k', 'alrayyes/app', [p]) as unknown as FakeNode;
  return wrap.children[0] as FakeNode;
};

describe('linkedPillName for an entry that carries its state', () => {
  test('is exactly the words the pill reads, with no noun before them', () => {
    expect(
      linkedPillName(
        pr({ kind: 'pullRequest', state: 'merged' }),
        'alrayyes/app',
      ),
    ).toBe('PR #12 · Merged, closes this issue');
  });

  test('an entry with no state keeps its noun', () => {
    expect(linkedPillName(pr(), 'alrayyes/app')).toBe(
      'Pull request #12, closes this issue',
    );
  });
});

describe('the cross-repo split in the pill', () => {
  test('puts the repo and the number in their own nodes, the rest around them', () => {
    const pill = pillOf(
      pr({ repo: 'alrayyes/other', kind: 'pullRequest', state: 'merged' }),
    );
    expect(tree(pill)).toEqual({
      tag: 'a',
      class: 'linked-pr',
      kids: [
        'PR ',
        {
          tag: 'span',
          class: 'linked-pr-ref',
          kids: [
            { tag: 'span', class: 'linked-pr-repo', kids: ['alrayyes/other'] },
            { tag: 'span', class: 'linked-pr-number', kids: ['#12'] },
          ],
        },
        ' · ',
        { tag: 'span', class: 'linked-pr-merged', kids: ['Merged'] },
      ],
    });
  });

  test('only a merged state gets the purple word', () => {
    for (const state of ['open', 'closed'] as const) {
      const pill = pillOf(pr({ kind: 'pullRequest', state }));
      expect(JSON.stringify(tree(pill))).not.toContain('linked-pr-merged');
    }
    const same = pillOf(pr({ kind: 'pullRequest', state: 'merged' }));
    expect(tree(same)).toEqual({
      tag: 'a',
      class: 'linked-pr',
      kids: [
        'PR #12 · ',
        { tag: 'span', class: 'linked-pr-merged', kids: ['Merged'] },
      ],
    });
  });

  test('the repo node carries the whole repo as its tooltip', () => {
    const pill = pillOf(pr({ repo: 'alrayyes/other' }));
    const ref = pill.children[1] as FakeNode;
    expect((ref.children[0] as FakeNode).title).toBe('alrayyes/other');
  });

  test('a leading empty piece is kept when the number starts the text', () => {
    const pill = pillOf(pr({ repo: 'alrayyes/other' }));
    const kids = pill.children;
    expect(kids[0]).toBe('');
    expect(kids[2]).toBe('');
    expect(kids).toHaveLength(3);
  });

  test('a same-repo pill is one plain text node', () => {
    const pill = pillOf(pr({ kind: 'pullRequest', state: 'open' }));
    expect(pill.children).toEqual(['PR #12 · Open']);
  });
});
