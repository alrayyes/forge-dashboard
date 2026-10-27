/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ciPillModel } from './ci-pill';

const counts = { passed: 8, running: 1, waiting: 2, failed: 3 };

// One model for the pull request rows, the bots board, the issue pills and the
// Main branches page, so the three never word or class a pill differently.
describe('ciPillModel', () => {
  test('a segmented pill leads with its word and carries the counts', () => {
    const m = ciPillModel({
      cls: 'failure',
      glyph: 'failure',
      word: 'Failed',
      counts,
    });

    expect(m.classes).toBe('ci-pill failure segmented');
    expect(m.segments.map((s) => s.kind)).toEqual([
      'passed',
      'running',
      'waiting',
      'failed',
    ]);
    expect(m.name).toBe(
      'Failed 8 1 2 3: 8 passed, 1 running, 2 waiting, 3 failed, still running',
    );
  });

  // A failed pill whose pipeline has not finished can still change, so it says
  // so: a marker beside the word, and the same in the spoken name.
  test('a failed pill with checks still going is marked live', () => {
    const running = ciPillModel({
      cls: 'failure',
      glyph: 'failure',
      word: 'Failed',
      counts: { passed: 0, running: 1, waiting: 0, failed: 1 },
    });
    const queued = ciPillModel({
      cls: 'failure',
      glyph: 'failure',
      word: 'Failed',
      counts: { passed: 0, running: 0, waiting: 2, failed: 1 },
    });

    expect(running.live).toBe(true);
    expect(queued.live).toBe(true);
    expect(running.name).toBe('Failed 1 1: 1 running, 1 failed, still running');
  });

  test('a failed pill with nothing left to run is not live', () => {
    const m = ciPillModel({
      cls: 'failure',
      glyph: 'failure',
      word: 'Failed',
      counts: { passed: 4, running: 0, waiting: 0, failed: 1 },
    });

    expect(m.live).toBe(false);
    expect(m.name).toBe('Failed 4 1: 4 passed, 1 failed');
  });

  test('only a failed pill is marked live', () => {
    const m = ciPillModel({
      cls: 'pending',
      glyph: 'running',
      word: 'Running',
      counts: { passed: 1, running: 1, waiting: 0, failed: 0 },
    });

    expect(m.live).toBe(false);
  });

  test('a failed pill with no counts is not live', () => {
    const m = ciPillModel({ cls: 'failure', glyph: 'failure', word: 'Failed' });

    expect(m.live).toBe(false);
  });

  test('keeps waiting as the spoken word for queued checks', () => {
    const m = ciPillModel({
      cls: 'pending',
      glyph: 'running',
      word: 'Running',
      counts: { passed: 0, running: 1, waiting: 8, failed: 0 },
    });

    expect(m.name).toContain('8 waiting');
  });

  test('a plain pill has no segments and its own word as the name', () => {
    const m = ciPillModel({ cls: 'success', glyph: 'success', word: 'Passed' });

    expect(m.classes).toBe('ci-pill success');
    expect(m.segments).toEqual([]);
    expect(m.name).toBe('Passed');
  });

  test('a pass that was only skipped checks is marked all-skipped', () => {
    const m = ciPillModel({
      cls: 'success',
      glyph: 'success',
      word: 'Passed',
      counts: { passed: 3, skipped: 3, running: 0, waiting: 0, failed: 0 },
    });

    expect(m.word).toBe('Skipped');
    expect(m.classes).toBe('ci-pill success all-skipped segmented');
  });

  test('a pass with checks that ran is not all-skipped', () => {
    const m = ciPillModel({
      cls: 'success',
      glyph: 'success',
      word: 'Passed',
      counts: { passed: 8, skipped: 2, running: 0, waiting: 0, failed: 0 },
    });

    expect(m.classes).toBe('ci-pill success segmented');
  });

  test('a held pill adds the awaiting class and ignores counts', () => {
    const m = ciPillModel({
      cls: 'failure',
      glyph: 'awaiting_approval',
      word: 'Waiting for workflow approval',
      awaiting: true,
      counts,
    });

    expect(m.classes).toBe('ci-pill failure awaiting');
    expect(m.segments).toEqual([]);
  });

  test('an all-skipped pass says Skipped', () => {
    const m = ciPillModel({
      cls: 'success',
      glyph: 'success',
      word: 'Passed',
      counts: { passed: 2, skipped: 2, running: 0, waiting: 0, failed: 0 },
    });

    expect(m.word).toBe('Skipped');
    expect(m.name).toBe('Skipped 2: 2 skipped');
  });

  test('segmented false keeps the plain pill whatever the counts', () => {
    const m = ciPillModel({
      cls: 'cancelled',
      glyph: 'cancelled',
      word: 'Cancelled',
      counts,
      segmented: false,
    });

    expect(m.segments).toEqual([]);
  });
});

// bun has no DOM, so a small stand-in covers what renderCiPill touches: nodes,
// attributes, text, and a class lookup. The browser behaviour is the pill
// specs; this pins which attributes and lines the renderer decides to add.
class FakeNode {
  children: FakeNode[] = [];
  attrs = new Map<string, string>();
  className = '';
  id = '';
  type = '';
  innerHTML = '';
  textContent = '';
  listeners: string[] = [];
  constructor(readonly tag: string) {}
  appendChild(n: FakeNode) {
    this.children.push(n);

    return n;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  addEventListener(name: string) {
    this.listeners.push(name);
  }
  hasClass(c: string) {
    return this.className.split(' ').includes(c);
  }
  find(c: string): FakeNode | undefined {
    for (const child of this.children) {
      if (child.hasClass(c)) return child;
      const deeper = child.find(c);
      if (deeper) return deeper;
    }

    return undefined;
  }
  querySelector(sel: string) {
    return this.find(sel.replace('.', '')) ?? null;
  }
}

const fakeDocument = {
  createElement: (tag: string) => new FakeNode(tag),
  createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
  createTextNode: (text: string) => {
    const n = new FakeNode('#text');
    n.textContent = text;

    return n;
  },
};

describe('renderCiPill', () => {
  const globals = globalThis as Record<string, unknown>;
  let render: typeof import('./ci-pill').renderCiPill;
  let glyphs: typeof import('./ci-pill').checkGlyphElements;

  beforeAll(async () => {
    globals.document = fakeDocument;
    globals.HTMLButtonElement = FakeNode;
    const mod = await import('./ci-pill');
    render = mod.renderCiPill;
    glyphs = mod.checkGlyphElements;
  });
  afterAll(() => {
    delete globals.document;
    delete globals.HTMLButtonElement;
  });

  const failed = () =>
    ciPillModel({ cls: 'failure', glyph: 'failure', word: 'Failed', counts });
  const as = (n: unknown) => n as FakeNode;

  test('a badge adds a hidden line saying the name and hides the sighted word', () => {
    const pill = as(render(failed()));

    expect(pill.tag).toBe('span');
    expect(as(pill.find('sr-only')).textContent).toBe(failed().name);
    expect(as(pill.find('ci-seg-label')).attrs.get('aria-hidden')).toBe('true');
  });

  test('announce false leaves the badge without the hidden line', () => {
    const pill = as(render(failed(), { announce: false }));

    expect(pill.find('sr-only')).toBeUndefined();
    expect(as(pill.find('ci-seg-label')).attrs.has('aria-hidden')).toBe(false);
  });

  test('a button is named by its model and opens the pipeline', () => {
    const pill = as(render(failed(), { onOpen: () => {}, id: 'p-1' }));

    expect(pill.tag).toBe('button');
    expect(pill.type).toBe('button');
    expect(pill.id).toBe('p-1');
    expect(pill.attrs.get('aria-label')).toBe(
      `${failed().name}. Open pipeline`,
    );
    expect(pill.listeners).toEqual(['click']);
    expect(pill.find('sr-only')).toBeUndefined();
  });

  test('a badge never takes the id', () => {
    expect(as(render(failed(), { id: 'p-1' })).id).toBe('');
  });

  test('a plain pill draws its glyph and word, or a dot when it has none', () => {
    const plain = as(
      render(ciPillModel({ cls: 'success', glyph: 'success', word: 'Passed' })),
    );
    const bare = as(
      render(ciPillModel({ cls: 'none', glyph: '', word: 'No checks' })),
    );

    expect(plain.children[0].tag).toBe('svg');
    expect(plain.children.at(-1)?.textContent).toBe('Passed');
    expect(bare.children[0].hasClass('dot')).toBe(true);
  });

  test('every count carries its glyph and is hidden from a screen reader', () => {
    const seg = as(as(render(failed())).find('ci-seg-waiting'));

    expect(seg.attrs.get('aria-hidden')).toBe('true');
    expect(seg.children[0].attrs.get('data-glyph')).toBeDefined();
    expect(seg.children.at(-1)?.textContent).toBe('2');
  });

  test('a live pill draws the running glyphs inside its label, hidden from a screen reader', () => {
    const label = as(as(render(failed())).find('ci-seg-label'));
    const live = as(label.find('ci-live'));

    expect(live.attrs.get('aria-hidden')).toBe('true');
    expect(live.children.map((g) => g.attrs.get('data-glyph')).sort()).toEqual([
      'arc',
      'clock',
    ]);
  });

  test('a pill that is not live draws no marker', () => {
    const done = ciPillModel({
      cls: 'failure',
      glyph: 'failure',
      word: 'Failed',
      counts: { passed: 4, running: 0, waiting: 0, failed: 1 },
    });

    expect(as(render(done)).find('ci-live')).toBeUndefined();
  });

  test('checkGlyphElements gives nothing for an unknown state', () => {
    expect(glyphs('nope')).toEqual([]);
  });
});
