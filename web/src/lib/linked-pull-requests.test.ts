/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  type LinkedPullRequest,
  linkedDialogName,
  linkedMoreName,
  linkedPillClass,
  linkedPillId,
  linkedPillName,
  linkedPillText,
  linkedPillTitle,
  missingNote,
  parsePullRequestAddress,
  splitLinked,
} from './linked-pull-requests';

// The issue row's pills and the address that opens a pull request's pop-up.
// The server decides which pull requests close an issue and builds each
// address, so this only words and reads them. The page wiring is
// linked-pull-requests.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/2082

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

describe('a pill that carries a pipeline', () => {
  const ci = {
    badge: {} as HTMLElement,
    label: 'Running',
    segments: [
      { kind: 'passed' as const, n: 3 },
      { kind: 'failed' as const, n: 1 },
    ],
  };

  test('reads the word and the counts after the number and state', () => {
    expect(linkedPillText(pr(), 'alrayyes/app', ci)).toBe('#12 Running 3 1');
  });

  test('says the counts in words, after the visible text it contains', () => {
    const name = linkedPillName(pr(), 'alrayyes/app', ci);
    expect(name).toBe(
      'Pull request #12 Running 3 1: 3 passed, 1 failed, closes this issue',
    );
    expect(name).toContain(linkedPillText(pr(), 'alrayyes/app', ci));
  });

  test('a held run is the word alone', () => {
    const held = {
      badge: ci.badge,
      label: 'Waiting for workflow approval',
      segments: [],
    };
    expect(linkedPillName(pr(), 'alrayyes/app', held)).toBe(
      'Pull request #12 Waiting for workflow approval, closes this issue',
    );
  });
});

describe('linkedPillText', () => {
  test('is the number and the state', () => {
    expect(linkedPillText(pr(), 'alrayyes/app')).toBe('#12');
    expect(linkedPillText(pr({ draft: true }), 'alrayyes/app')).toBe(
      '#12 draft',
    );
  });

  test('names the repo when the pull request is in another one', () => {
    expect(linkedPillText(pr({ repo: 'alrayyes/other' }), 'alrayyes/app')).toBe(
      'alrayyes/other#12',
    );
  });

  test('compares repos without regard to case, as Forgejo spells them lowercased', () => {
    expect(linkedPillText(pr({ repo: 'Ryan/Hush' }), 'ryan/hush')).toBe('#12');
  });
});

describe('linkedPillName', () => {
  test('says what it is and that it closes the issue, and contains the visible text', () => {
    const name = linkedPillName(pr(), 'alrayyes/app');
    expect(name).toBe('Pull request #12, closes this issue');
    expect(name).toContain(linkedPillText(pr(), 'alrayyes/app'));
  });

  test('says it mentions the issue when that is what the pull request does', () => {
    expect(linkedPillName(pr(), 'alrayyes/app', null, 'mentions')).toBe(
      'Pull request #12, mentions this issue',
    );
  });

  test('says it references the issue when that is what the pull request does', () => {
    expect(linkedPillName(pr(), 'alrayyes/app', null, 'refs')).toBe(
      'Pull request #12, references, does not close this issue',
    );
  });

  test('says in its tooltip what each relation does to the issue', () => {
    expect(linkedPillTitle('closes')).toBe('Closes this issue when it merges');
    expect(linkedPillTitle('refs')).toBe(
      'References this issue, does not close it',
    );
    expect(linkedPillTitle('mentions')).toBe(
      'Mentions this issue, does not close it',
    );
  });

  test('carries the whole repo when it is another one, and still the visible text', () => {
    const other = pr({ repo: 'alrayyes/other', draft: true });
    const name = linkedPillName(other, 'alrayyes/app');
    expect(name).toBe(
      'Pull request alrayyes/other#12 draft, closes this issue',
    );
    expect(name).toContain(linkedPillText(other, 'alrayyes/app'));
  });
});

describe('splitLinked', () => {
  const list = (n: number) =>
    Array.from({ length: n }, (_, i) => pr({ number: i + 1 }));

  test('shows up to two and keeps the rest behind a count', () => {
    expect(splitLinked(list(1))).toEqual({ shown: list(1), rest: [] });
    expect(splitLinked(list(2))).toEqual({ shown: list(2), rest: [] });
    const three = splitLinked(list(3));
    expect(three.shown.map((p) => p.number)).toEqual([1, 2]);
    expect(three.rest.map((p) => p.number)).toEqual([3]);
  });
});

describe('parsePullRequestAddress', () => {
  test('reads forge, repo and number from ?pr=', () => {
    expect(
      parsePullRequestAddress('?pr=github/alrayyes/forge-dashboard/2082'),
    ).toEqual({
      forge: 'github',
      repo: 'alrayyes/forge-dashboard',
      number: 2082,
    });
    expect(parsePullRequestAddress('?x=1&pr=forgejo/Ryan/Hush/7')).toEqual({
      forge: 'forgejo',
      repo: 'Ryan/Hush',
      number: 7,
    });
  });

  test('reads the percent-encoded form too', () => {
    expect(parsePullRequestAddress('?pr=github%2Fo%2Fa%2F5')).toEqual({
      forge: 'github',
      repo: 'o/a',
      number: 5,
    });
  });

  test('is null for anything else', () => {
    for (const search of [
      '',
      '?pr=',
      '?pr=github/o/a',
      '?pr=github/o/a/x',
      '?pr=github/o/a/0',
      '?pr=github/o/a/-3',
      '?pr=github/o/a/1.5',
      '?pr=gitlab/o/a/3',
      '?pr=github//a/3',
      '?other=github/o/a/3',
    ])
      expect(parsePullRequestAddress(search)).toBeNull();
  });
});

describe('missingNote', () => {
  test('says a pull request that is nowhere is not open any more', () => {
    expect(missingNote({ forge: 'github', repo: 'o/a', number: 5 })).toBe(
      'Pull request o/a #5 is not open any more, or this dashboard does not track it.',
    );
  });
});

describe('linkedPillId', () => {
  test('is a safe id that differs per pull request and per issue', () => {
    const id = linkedPillId('github/alrayyes/app/1', pr());
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id).not.toBe(
      linkedPillId('github/alrayyes/app/1', pr({ number: 13 })),
    );
    expect(id).not.toBe(linkedPillId('github/alrayyes/app/2', pr()));
  });
});

describe('linkedPillClass', () => {
  test('a closing pill is plain, a draft one says so', () => {
    expect(linkedPillClass(pr(), 'closes')).toBe('linked-pr');
    expect(linkedPillClass(pr({ draft: true }), 'closes')).toBe(
      'linked-pr draft',
    );
  });

  test('a mention and a ref are each drawn apart from a closing pill', () => {
    expect(linkedPillClass(pr(), 'mentions')).toBe('linked-pr mention-pill');
    expect(linkedPillClass(pr(), 'refs')).toBe('linked-pr refs-pill');
    expect(linkedPillClass(pr({ draft: true }), 'refs')).toBe(
      'linked-pr draft refs-pill',
    );
  });
});

describe('linkedMoreName', () => {
  test('says which relation the hidden pull requests have', () => {
    expect(linkedMoreName(3, 'closes')).toBe(
      '3 more pull requests that will close this issue',
    );
    expect(linkedMoreName(3, 'mentions')).toBe(
      '3 more pull requests that mention this issue',
    );
    expect(linkedMoreName(3, 'refs')).toBe(
      '3 more pull requests that reference this issue',
    );
  });
});

describe('the forges a pull request address accepts', () => {
  test('a forge the server registered is accepted, one it never named is not', async () => {
    const { registerForgeCapabilities, resetForgeCapabilities } = await import(
      './forges'
    );
    try {
      expect(parsePullRequestAddress('?pr=gitea/o/r/1')).toBeNull();
      registerForgeCapabilities([{ forge: 'gitea' }]);
      expect(parsePullRequestAddress('?pr=gitea/o/r/1')).toEqual({
        forge: 'gitea',
        repo: 'o/r',
        number: 1,
      });
    } finally {
      resetForgeCapabilities();
    }
  });
});

// In the Related band a pill's name leads with the row's relation, then the
// same words the row's pill says (#4220, AC7): one form for every pill.
describe('linkedDialogName', () => {
  const ci = {
    badge: {} as HTMLElement,
    label: 'Running',
    segments: [
      { kind: 'passed' as const, n: 3 },
      { kind: 'failed' as const, n: 1 },
    ],
  };

  test('leads with the relation, then the number, the draft word and the pipeline in words', () => {
    expect(
      linkedDialogName(pr({ number: 142, draft: true }), 'alrayyes/app', ci),
    ).toBe(
      'Closed by: Pull request #142 draft Running 3 1: 3 passed, 1 failed',
    );
  });

  test('says the other relations by their row labels', () => {
    expect(linkedDialogName(pr(), 'alrayyes/app', null, 'refs')).toBe(
      'Referenced by: Pull request #12',
    );
    expect(linkedDialogName(pr(), 'alrayyes/app', null, 'mentions')).toBe(
      'Mentioned by: Pull request #12',
    );
  });

  test('names the repo of a pull request in another one', () => {
    expect(
      linkedDialogName(pr({ repo: 'alrayyes/other' }), 'alrayyes/app'),
    ).toBe('Closed by: Pull request alrayyes/other#12');
  });

  test('contains the pill visible text', () => {
    const p = pr({ draft: true });
    expect(linkedDialogName(p, 'alrayyes/app', ci)).toContain(
      linkedPillText(p, 'alrayyes/app', ci),
    );
  });
});
