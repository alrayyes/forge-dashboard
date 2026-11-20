/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type LinkedPullRequest,
  linkedDialogName,
  linkedPillId,
  linkedPillName,
  linkedPills,
  type PillCi,
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
  listeners: Record<string, (event?: unknown) => void> = {};
  focused = false;
  classList = {
    add: (c: string) => (this.className += ` ${c}`),
    contains: (c: string) => this.className.split(' ').includes(c),
  };
  constructor(readonly tag: string) {}
  get firstElementChild() {
    return this.children.find((c) => typeof c !== 'string');
  }
  focus() {
    this.focused = true;
  }
  parent?: FakeNode;
  replaceWith(...nodes: (FakeNode | string)[]) {
    this.replacedBy = nodes;
    const siblings = this.parent?.children;
    const at = siblings ? siblings.indexOf(this) : -1;
    if (siblings && at >= 0) siblings.splice(at, 1, ...nodes);
  }
  replacedBy: (FakeNode | string)[] = [];
  set textContent(text: string) {
    this.children = [text];
  }
  append(...nodes: (FakeNode | string)[]) {
    this.children.push(...nodes);
    for (const n of nodes) if (typeof n !== 'string') n.parent = this;
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
        ' · Merged',
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

// The pipeline badge, the aria-label choice and the wiring of a pill (#4385).
// https://github.com/alrayyes/forge-dashboard/issues/4385

const badge = new FakeNode('span');
const ci = (): PillCi => ({
  badge: badge as unknown as HTMLElement,
  label: 'Running',
  segments: [{ n: 3 }] as unknown as PillCi['segments'],
});
const asNode = (n: unknown) => n as FakeNode;
const wrapOf = (
  list: LinkedPullRequest[],
  ...args: Parameters<typeof linkedPills> extends [
    unknown,
    unknown,
    unknown,
    ...infer R,
  ]
    ? R
    : never
) => asNode(linkedPills('k', 'alrayyes/app', list, ...args));

describe('a pill that carries a pipeline badge', () => {
  const withCi = () => asNode(wrapOf([pr()], undefined, ci).children[0]);

  test('appends the badge after a space, following the text', () => {
    expect(withCi().children).toEqual(['#12', ' ', badge]);
  });

  test('adds the with-ci class to the pill', () => {
    expect(withCi().className).toBe('linked-pr with-ci');
  });

  test('a pill with no pipeline has neither space, badge nor class', () => {
    const pill = asNode(wrapOf([pr()], undefined, () => null).children[0]);
    expect(pill.children).toEqual(['#12']);
    expect(pill.className).toBe('linked-pr');
  });

  test('without a renderer the renderer is not asked and nothing is added', () => {
    const pill = pillOf(pr());
    expect(pill.children).toEqual(['#12']);
    expect(pill.className).toBe('linked-pr');
  });

  test('the renderer is given the pull request', () => {
    const seen: LinkedPullRequest[] = [];
    const p = pr({ number: 7 });
    wrapOf([p], undefined, (x) => {
      seen.push(x);
      return null;
    });
    expect(seen).toEqual([p]);
  });

  test('the pipeline is in the text of the accessible name', () => {
    expect(withCi().attrs['aria-label']).toBe(
      linkedPillName(pr(), 'alrayyes/app', ci()),
    );
  });
});

describe('the aria-label of a pill', () => {
  test('outside a dialog is the pill name, with the relation after the words', () => {
    const host = asNode(
      wrapOf([pr()], undefined, undefined, undefined, 'refs').children[0],
    );
    expect(asNode(host.children[0]).attrs['aria-label']).toBe(
      'Pull request #12, references, does not close this issue',
    );
  });

  test('in a dialog leads with the relation, and the side is passed on', () => {
    const wrap = wrapOf(
      [pr()],
      undefined,
      undefined,
      undefined,
      'closes',
      true,
      'issue-outgoing',
    );
    const label = asNode(wrap.children[0]).attrs['aria-label'];
    expect(label).toBe(
      linkedDialogName(pr(), 'alrayyes/app', null, 'closes', 'issue-outgoing'),
    );
    expect(label).not.toBe(linkedPillName(pr(), 'alrayyes/app'));
  });

  test('in a dialog the pipeline is passed in, and a pill with none is not given one', () => {
    const withCi = asNode(
      wrapOf([pr()], undefined, ci, undefined, 'closes', true).children[0],
    );
    expect(withCi.attrs['aria-label']).toBe(
      linkedDialogName(pr(), 'alrayyes/app', ci()),
    );
    const none = asNode(
      wrapOf([pr()], undefined, undefined, undefined, 'closes', true)
        .children[0],
    );
    expect(none.attrs['aria-label']).toBe(
      linkedDialogName(pr(), 'alrayyes/app', null),
    );
  });

  test('outside a dialog a pill with no pipeline is named without one', () => {
    expect(pillOf(pr()).attrs['aria-label']).toBe(
      'Pull request #12, closes this issue',
    );
  });
});

describe('the attributes and wiring of a pill', () => {
  test('an anchor links to the page and says in its tooltip what it does', () => {
    const pill = pillOf(pr()) as FakeAnchor;
    expect(pill.tag).toBe('a');
    expect(pill.href).toBe('/pull-requests.html?pr=github/alrayyes/app/12');
    expect(pill.title).toBe('Closes this issue when it merges');
  });

  test('a click on the anchor follows in place when onFollow is given', () => {
    const followed: LinkedPullRequest[] = [];
    const p = pr();
    const pill = asNode(
      wrapOf([p], undefined, undefined, (x) => followed.push(x)).children[0],
    );
    let prevented = false;
    pill.listeners.click({
      button: 0,
      preventDefault: () => (prevented = true),
    });
    expect(prevented).toBe(true);
    expect(followed).toEqual([p]);
  });

  test('a modified click is left to the browser', () => {
    const followed: LinkedPullRequest[] = [];
    const pill = asNode(
      wrapOf([pr()], undefined, undefined, (x) => followed.push(x)).children[0],
    );
    let prevented = false;
    pill.listeners.click({
      button: 0,
      ctrlKey: true,
      metaKey: true,
      preventDefault: () => (prevented = true),
    });
    expect(prevented).toBe(false);
    expect(followed).toEqual([]);
  });

  test('with onOpen the pill is a button with the pill id, and opens with that id', () => {
    const opened: [LinkedPullRequest, string][] = [];
    const p = pr();
    const pill = asNode(
      wrapOf([p], (x, id) => opened.push([x, id])).children[0],
    ) as FakeButton;
    expect(pill.tag).toBe('button');
    expect(pill.type).toBe('button');
    expect(pill.id).toBe(linkedPillId('k', p));
    expect(pill.href).toBe('');
    pill.listeners.click();
    expect(opened).toEqual([[p, linkedPillId('k', p)]]);
  });

  test('a button pill has no click handler for following', () => {
    const pill = asNode(
      wrapOf(
        [pr()],
        () => {},
        undefined,
        () => {},
      ).children[0],
    );
    expect(Object.keys(pill.listeners)).toEqual(['click']);
  });

  test('a ref pill sits in a tip host, a closing pill does not', () => {
    const host = asNode(
      wrapOf([pr()], undefined, undefined, undefined, 'refs').children[0],
    );
    expect(host.className).toBe('pill-tip-host');
    const pill = asNode(host.children[0]);
    expect(pill.className).toBe('linked-pr refs-pill');
    expect(pill.title).toBe('References this issue, does not close it');
    expect(asNode(host.children[1]).children).toEqual([
      'References this issue, does not close it',
    ]);
    expect(pillOf(pr()).className).toBe('linked-pr');
  });

  test('a mention pill gets its own class and tooltip, with no tip host', () => {
    const pill = asNode(
      wrapOf([pr()], undefined, undefined, undefined, 'mentions').children[0],
    );
    expect(pill.className).toBe('linked-pr mention-pill');
    expect(pill.title).toBe('Mentions this issue, does not close it');
  });

  test('a draft pill carries the draft class', () => {
    expect(pillOf(pr({ draft: true })).className).toBe('linked-pr draft');
  });

  test('a row with no pull requests has no pills', () => {
    expect(linkedPills('k', 'alrayyes/app', [])).toBeNull();
    expect(linkedPills('k', 'alrayyes/app', undefined)).toBeNull();
  });
});

describe('the pills a row shows and the count that holds the rest', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => pr({ number: i + 1 }));
  const texts = (w: FakeNode) => w.children.map((c) => asNode(c).children[0]);

  test('two pills and no count when there are two', () => {
    expect(texts(wrapOf(many(2)))).toEqual(['#1', '#2']);
  });

  test('two pills then a count button holding the rest', () => {
    const wrap = wrapOf(many(5), undefined, undefined, undefined, 'mentions');
    expect(texts(wrap)).toEqual(['#1', '#2', '3 more']);
    const more = asNode(wrap.children[2]) as FakeButton;
    expect(more.tag).toBe('button');
    expect(more.type).toBe('button');
    expect(more.className).toBe('linked-pr-more');
    expect(more.attrs['aria-label']).toBe(
      '3 more pull requests that mention this issue',
    );
  });

  test('opening the count swaps in the rest and focuses the first', () => {
    const wrap = wrapOf(many(4), undefined, undefined, undefined, 'closes');
    const more = asNode(wrap.children[2]);
    more.listeners.click();
    expect(more.replacedBy.map((n) => asNode(n).children[0])).toEqual([
      '#3',
      '#4',
    ]);
    expect(asNode(more.replacedBy[0]).focused).toBe(true);
    expect(asNode(more.replacedBy[1]).focused).toBe(false);
  });

  test('a row the reader opened is drawn open again', () => {
    const w1 = asNode(linkedPills('again', 'alrayyes/app', many(3)));
    asNode(w1.children[2]).listeners.click();
    const w2 = asNode(linkedPills('again', 'alrayyes/app', many(3)));
    expect(texts(w2)).toEqual(['#1', '#2', '#3']);
  });

  test('a ref pill that was held back is focused through its host', () => {
    const wrap = wrapOf(many(3), undefined, undefined, undefined, 'refs');
    const more = asNode(wrap.children[2]);
    more.listeners.click();
    const host = asNode(more.replacedBy[0]);
    expect(host.className).toBe('pill-tip-host');
    expect(asNode(host.children[0]).focused).toBe(true);
    expect(host.focused).toBe(false);
  });
});
