import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { IssueActionsHost } from './issue-dialog-actions';

// rate-limit.ts reads a rune-based module the test runner can't compile.
mock.module('./time.svelte', () => ({ formatTime: (t: string) => t }));
const { createIssueActions } = await import('./issue-dialog-actions');

// The controller builds plain DOM nodes. This stand-in keeps just what it
// touches, so the state machine can be driven without a browser.
class FakeNode {
  children: FakeNode[] = [];
  listeners: Record<string, Array<() => void>> = {};
  attrs: Record<string, string> = {};
  className = '';
  textContent = '';
  id = '';
  type = '';
  value = '';
  rows = 0;
  htmlFor = '';
  readOnly = false;
  constructor(public tag: string) {}
  addEventListener(name: string, fn: () => void) {
    this.listeners[name] = [...(this.listeners[name] ?? []), fn];
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  append(...nodes: FakeNode[]) {
    this.children.push(...nodes);
  }
  appendChild(node: FakeNode) {
    this.children.push(node);
  }
  focus() {}
  fire(name: string) {
    for (const fn of this.listeners[name] ?? []) fn();
  }
}

type Chrome = {
  actions: FakeNode[];
  option: FakeNode | null;
  feedback: FakeNode | null;
};

function walk(node: FakeNode, out: FakeNode[] = []): FakeNode[] {
  out.push(node);
  for (const child of node.children) walk(child, out);
  return out;
}

const original = {
  document: globalThis.document,
  fetch: globalThis.fetch,
};

let chrome: Chrome;
let posts: Array<{ path: string; body: Record<string, unknown> }>;
let answers: Record<string, number[]>;

function setup() {
  chrome = { actions: [], option: null, feedback: null };
  posts = [];
  answers = {};
  (globalThis as { document: unknown }).document = {
    createElement: (tag: string) => new FakeNode(tag),
    getElementById: () => null,
  };
  globalThis.fetch = ((path: string, init: { body: string }) => {
    const kind = path.split('/').pop() ?? '';
    posts.push({ path: kind, body: JSON.parse(init.body) });
    const status = answers[kind]?.shift() ?? 204;
    return Promise.resolve(
      new Response(
        status === 204
          ? null
          : JSON.stringify({ code: 'forge_error', message: 'Bad gateway.' }),
        { status },
      ),
    );
  }) as unknown as typeof fetch;
  const host: IssueActionsHost = {
    render: (c) => {
      chrome = c as unknown as Chrome;
    },
    showClosed: () => {},
    refresh: () => {},
    announce: () => {},
    forgeLock: () => null,
    rateLimitReason: () => 'limited',
    forgeLabel: (f) => f,
  };
  return createIssueActions(host);
}

const target = { forge: 'github', repo: 'a/b', number: 7 };

function button(name: string): FakeNode {
  const nodes = chrome.actions.flatMap((n) => walk(n));
  const found = nodes.find((n) => n.tag === 'button' && n.textContent === name);
  if (!found) throw new Error(`no button "${name}"`);
  return found;
}

function field(): FakeNode {
  const found = walk(chrome.option as FakeNode).find(
    (n) => n.tag === 'textarea',
  );
  if (!found) throw new Error('no comment field');
  return found;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function typeAndSend(text: string) {
  button('Close with a comment').fire('click');
  const f = field();
  f.value = text;
  f.fire('input');
  button('Comment and close').fire('click');
  await settle();
}

afterEach(() => {
  (globalThis as { document: unknown }).document = original.document;
  globalThis.fetch = original.fetch;
});

describe('Close with a comment', () => {
  test('posts the comment, then closes', async () => {
    const actions = setup();
    actions.open(target);
    await typeAndSend('Done.');

    expect(posts.map((p) => p.path)).toEqual(['comment', 'close']);
  });

  test('after a posted comment and a failed close, Escape and a new comment posts the new one', async () => {
    const actions = setup();
    answers.close = [502];
    actions.open(target);
    await typeAndSend('First.');
    expect(posts.map((p) => p.path)).toEqual(['comment', 'close']);

    expect(actions.escape()).toBe(true);
    await typeAndSend('Second.');

    expect(posts.map((p) => p.path)).toEqual([
      'comment',
      'close',
      'comment',
      'close',
    ]);
    expect(posts[2].body.body).toBe('Second.');
  });

  test('a read saying the issue is closed also forgets a comment that was posted', async () => {
    const actions = setup();
    answers.close = [502];
    actions.open(target);
    await typeAndSend('First.');

    actions.forgeState(true);
    const real = Date.now;
    Date.now = () => real() + 60_000;
    try {
      actions.forgeState(false);
    } finally {
      Date.now = real;
    }
    await typeAndSend('Second.');

    expect(posts.at(-2)?.path).toBe('comment');
    expect(posts.at(-2)?.body.body).toBe('Second.');
  });
});
