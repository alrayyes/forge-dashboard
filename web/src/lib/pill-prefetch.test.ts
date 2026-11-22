/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { createCheckFeed, STREAM_SUBJECT_CAP } from './check-feed';
import { registerForgeCapabilities, resetForgeCapabilities } from './forges';
import {
  advisoriesReadInFlight,
  warmAdvisories,
  warmChecks,
} from './pill-prefetch';
import type { Check } from './pipeline-checks';
import { pickExcerptJobs } from './pipeline-excerpts';
import { createWarmer } from './prefetch';

afterEach(resetForgeCapabilities);

const json = (body: object) => new Response(JSON.stringify(body));
const asFetch = (fn: (url: string) => Promise<Response>) =>
  fn as unknown as typeof fetch;

describe('warmAdvisories', () => {
  test('reads the list the server has not kept yet, without refresh (#4192)', async () => {
    const urls: string[] = [];
    warmAdvisories({ forge: 'github', fullName: 'a/b' }, async (url) => {
      urls.push(url);
      return json({ state: 'known', advisories: [] });
    });
    await Promise.resolve();
    expect(urls).toEqual([
      '/api/v1/main-branches/advisories?forge=github&fullName=a%2Fb',
    ]);
  });

  test('a list the server already keeps costs no request', () => {
    let calls = 0;
    warmAdvisories(
      {
        forge: 'github',
        fullName: 'a/b',
        advisories: {
          state: 'known',
          count: 1,
          listReadAt: new Date().toISOString(),
        } as never,
      },
      async () => {
        calls++;
        return json({});
      },
    );
    expect(calls).toBe(0);
  });

  test('a read still out is one the dialog can wait on, and is read once', async () => {
    let calls = 0;
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const fetcher = async () => {
      calls++;
      await gate;
      return json({ state: 'known', advisories: [] });
    };
    const row = { forge: 'github', fullName: 'c/d' };
    warmAdvisories(row, fetcher);
    warmAdvisories(row, fetcher);
    const waiting = advisoriesReadInFlight(row);
    expect(waiting).toBeDefined();
    finish();
    expect((await waiting)?.kind).toBe('ready');
    expect(calls).toBe(1);
    await Promise.resolve();
    expect(advisoriesReadInFlight(row)).toBeUndefined();
  });
});

const failed = (jobId: number): Check => ({
  name: `job ${jobId}`,
  status: 'completed',
  conclusion: 'failure',
  url: `https://x/${jobId}`,
  jobId,
  runAttempt: 1,
});

function feed() {
  let listener: ((m: { checks: Check[] }) => void) | undefined;
  let unwatched = 0;
  return {
    watch: (_s: unknown, l: (m: { checks: Check[] }) => void) => {
      listener = l;
      return () => {
        unwatched++;
      };
    },
    tell: (checks: Check[]) => listener?.({ checks }),
    unwatched: () => unwatched,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('warmChecks', () => {
  const repo = { forge: 'forgejo', fullName: 'a/b' };
  const subject = { kind: 'main_branch' as const, ...repo };
  const withExcerpts = () =>
    registerForgeCapabilities([
      { forge: 'forgejo', capabilities: { serverLogExcerpts: true } },
    ]);

  test('watches the row and reads the excerpts of its failed jobs', async () => {
    withExcerpts();
    const f = feed();
    const urls: string[] = [];
    const warm = warmChecks(
      subject,
      repo,
      f,
      asFetch(async (url) => {
        urls.push(String(url));
        return json({ text: 'boom' });
      }),
    );
    f.tell([failed(7), failed(9)]);
    await flush();
    expect(urls.length).toBe(2);
    expect(urls[0]).toContain('jobId=9');
    expect(urls[0]).toContain('excerpt=true');
    expect(f.unwatched()).toBe(0);
    warm.release();
    expect(f.unwatched()).toBe(1);
  });

  test('a later list on the same watch asks for nothing twice', async () => {
    withExcerpts();
    const f = feed();
    let calls = 0;
    warmChecks(
      subject,
      repo,
      f,
      asFetch(async () => {
        calls++;
        return json({ text: 'x' });
      }),
    );
    f.tell([failed(1)]);
    f.tell([failed(1)]);
    await flush();
    expect(calls).toBe(1);
  });

  test('the retries of an empty log stop once the hold is let go', async () => {
    withExcerpts();
    const f = feed();
    let calls = 0;
    let wake!: () => void;
    const warm = warmChecks(
      subject,
      repo,
      f,
      asFetch(async () => {
        calls++;
        return json({ text: '' });
      }),
      () => new Promise<void>((r) => (wake = r)),
    );
    f.tell([failed(1)]);
    await flush();
    expect(calls).toBe(1);
    warm.release();
    wake();
    await flush();
    expect(calls).toBe(1);
  });

  test('the retries stop when the dialog opens, and it takes over what was read and spent', async () => {
    withExcerpts();
    const f = feed();
    const urls: string[] = [];
    let wake!: () => void;
    const warm = warmChecks(
      subject,
      repo,
      f,
      asFetch(async (url) => {
        urls.push(String(url));
        return json({ text: String(url).includes('jobId=3') ? 'boom' : '' });
      }),
      () => new Promise<void>((r) => (wake = r)),
    );
    f.tell([failed(1), failed(2), failed(3)]);
    await flush();
    const taken = warm.handoff();
    wake();
    await flush();
    expect(urls.length).toBe(3);
    expect(Object.values(taken.excerpts)).toEqual(['boom']);
    // Three reads were spent. Only the filled job is marked asked; the empty
    // two may be picked again, from the two reads left.
    expect(taken.reads.asked.size).toBe(1);
    expect(taken.reads.left).toBe(2);
    // The dialog's own picks can never take the open past five reads.
    const more = pickExcerptJobs([1, 2, 3, 4, 5, 6].map(failed), taken.reads);
    expect(more.length).toBe(2);
    expect(more.map((c) => c.jobId)).not.toContain(3);
    expect(urls.length + more.length).toBeLessThanOrEqual(5);
    expect(f.unwatched()).toBe(0);
    warm.release();
    expect(f.unwatched()).toBe(1);
  });
});

describe('warmChecks handoff of reads still out', () => {
  test('a job read while the dialog opens can be picked again, within five reads', async () => {
    registerForgeCapabilities([
      { forge: 'forgejo', capabilities: { serverLogExcerpts: true } },
    ]);
    const repo = { forge: 'forgejo', fullName: 'a/b' };
    const f = feed();
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    let urls = 0;
    const warm = warmChecks(
      { kind: 'main_branch', ...repo },
      repo,
      f,
      asFetch(async () => {
        urls++;
        await gate;
        return json({ text: 'late' });
      }),
    );
    f.tell([failed(1), failed(2)]);
    await flush();
    const taken = warm.handoff();
    finish();
    await flush();
    // Reads run one at a time: one was out at the handoff, the other queued
    // behind it. The answer is dropped and the queued read is never sent.
    expect(taken.excerpts).toEqual({});
    expect(taken.reads.left).toBe(3);
    const again = pickExcerptJobs([failed(1), failed(2)], taken.reads);
    expect(again.length).toBe(2);
    expect(urls + again.length).toBeLessThanOrEqual(5);
    expect(pickExcerptJobs([failed(1), failed(2)], taken.reads)).toEqual([]);
  });
});

describe('the stream cap', () => {
  const subjectOf = (n: number) => ({
    kind: 'main_branch' as const,
    forge: 'github',
    fullName: `o/r${n}`,
  });

  function stream() {
    const sizes: number[] = [];
    const checkFeed = createCheckFeed({
      newId: () => 'sid',
      post: async (body) => {
        sizes.push(JSON.parse(body).subjects.length);
        return 204;
      },
    });
    checkFeed.attach({
      addEventListener: () => {},
      readyState: 1,
    });
    // The page's own watch: the first seven rows.
    for (let n = 1; n < STREAM_SUBJECT_CAP; n++)
      checkFeed.watch(subjectOf(n), () => {});
    return { checkFeed, sizes };
  }

  test('a row the page already watches adds no subject', async () => {
    const { checkFeed, sizes } = stream();
    await flush();
    const before = sizes.length;
    const warm = warmChecks(subjectOf(3), subjectOf(3), checkFeed);
    await flush();
    warm.release();
    await flush();
    expect(sizes.slice(before)).toEqual([]);
  });

  test('hovering row after row never takes more than the cap, the dialog included', async () => {
    const { checkFeed, sizes } = stream();
    const holds = new Map<string, ReturnType<typeof warmChecks>>();
    const warmer = createWarmer({
      exclusive: true,
      start: (key) => {
        const n = Number(key);
        const warm = warmChecks(subjectOf(n), subjectOf(n), checkFeed);
        holds.set(key, warm);
        return () => {
          holds.delete(key);
          warm.release();
        };
      },
    });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    warmer.enter('20');
    await wait(150);
    warmer.enter('21');
    await wait(150);
    warmer.enter('22');
    await wait(150);
    // The dialog opens on 22 while 21's hold would still be in its grace.
    warmer.releaseExcept('22');
    checkFeed.watch(subjectOf(22), () => {});
    warmer.opened('22');
    await flush();
    warmer.destroy();
    expect(Math.max(...sizes)).toBeLessThanOrEqual(STREAM_SUBJECT_CAP);
  });
});
