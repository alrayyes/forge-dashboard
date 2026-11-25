/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  type ActionCode,
  type ActionOutcome,
  interpretActionFailure,
  readActionFailure,
  settledBadge,
} from './action-error';

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

// Every code the spec lists needs a decision in the client, so a new code
// can't land and quietly read as `unknown` (#4916).
describe('every ActionError.code the spec lists', () => {
  const spec = readFileSync(
    new URL('../../../api/openapi.yaml', import.meta.url),
    'utf8',
  );
  const listed = (
    spec.match(
      /ActionError:[\s\S]*?x-extensible-enum:\n((?:\s+- \w+\n)+)/,
    )?.[1] ?? ''
  )
    .split('\n')
    .map((l) => l.replace(/^\s+- /, '').trim())
    .filter(Boolean);

  const DECISIONS: Record<ActionCode, ActionOutcome['kind']> = {
    already_merged: 'settled',
    already_closed: 'settled',
    not_mergeable: 'locked',
    conflict: 'locked',
    behind: 'locked',
    checks_pending: 'locked',
    status_unknown: 'locked',
    checks_failing: 'locked',
    blocked_by_protection: 'locked',
    already_up_to_date: 'locked',
    already_requested: 'locked',
    auto_merge_not_allowed: 'locked',
    ready_to_merge: 'locked',
    label_missing: 'locked',
    not_reopenable: 'locked',
    stacked: 'locked',
    not_open: 'locked',
    permission: 'locked',
    rate_limited: 'locked',
    forge_error: 'failed',
    forge_unreachable: 'failed',
    not_rate_limited: 'failed',
    unknown: 'failed',
  };

  const decode = (code: string) =>
    readActionFailure(
      new Response(JSON.stringify({ code, message: 'A plain sentence.' }), {
        status: 409,
      }),
    );

  test('the spec list is read', () => {
    expect(listed.length).toBeGreaterThan(20);
  });

  test('the client has a decision for exactly those codes', () => {
    expect(Object.keys(DECISIONS).sort()).toEqual([...listed].sort());
  });

  for (const code of Object.keys(DECISIONS) as ActionCode[]) {
    test(`${code} decodes as itself and gets its decision`, async () => {
      const err = await decode(code);
      expect(err.code).toBe(code);
      const outcome = interpretActionFailure(err, () => 'Rate limited.');
      expect(outcome.kind).toBe(DECISIONS[code]);
    });
  }

  test('forge_unreachable passes by itself and the row line clears', async () => {
    const outcome = interpretActionFailure(
      await decode('forge_unreachable'),
      () => '',
    );
    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'A plain sentence.',
      transient: true,
    });
  });

  test('a code the client has never heard of falls back to unknown', async () => {
    const err = await decode('from_the_future');
    expect(err.code).toBe('unknown');
    expect(err.message).toBe('A plain sentence.');
    expect(interpretActionFailure(err, () => '').kind).toBe('failed');
  });
});
