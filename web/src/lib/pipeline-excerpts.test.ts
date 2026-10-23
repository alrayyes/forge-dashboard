/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { Check } from './pipeline-checks';
import {
  EXCERPT_RETRY_DELAY_MS,
  excerptKey,
  excerptUrl,
  fillExcerpts,
  MAX_EXCERPT_READS,
  pickExcerptJobs,
} from './pipeline-excerpts';

const FORGEJO =
  '/api/pull-requests/checks?forge=forgejo&fullName=a%2Fb&number=4';
const GITHUB = '/api/pull-requests/checks?forge=github&fullName=a%2Fb&number=4';

const failed = (jobId: number, extra: Partial<Check> = {}): Check => ({
  name: `job ${jobId}`,
  state: 'failure',
  url: `https://x/${jobId}`,
  jobId,
  runAttempt: 1,
  ...extra,
});

describe('excerptUrl', () => {
  test('asks the log endpoint for the excerpt of a Forgejo job', () => {
    expect(excerptUrl(FORGEJO, 7)).toBe(
      '/api/checks/log?forge=forgejo&fullName=a%2Fb&jobId=7&excerpt=true',
    );
  });

  test('is null on GitHub, which fills the excerpt in the list', () => {
    expect(excerptUrl(GITHUB, 7)).toBeNull();
  });

  test('is null when the checks url names no repository', () => {
    expect(excerptUrl('/api/main-branches/checks', 7)).toBeNull();
  });
});

describe('pickExcerptJobs', () => {
  test('takes the newest five failed jobs that have no excerpt', () => {
    const checks = [1, 2, 3, 4, 5, 6, 7].map((id) => failed(id));

    expect(pickExcerptJobs(checks, new Set()).map((c) => c.jobId)).toEqual([
      7, 6, 5, 4, 3,
    ]);
    expect(MAX_EXCERPT_READS).toBe(5);
  });

  test('takes timed out jobs, and no passed, cancelled or job-less check', () => {
    const checks = [
      failed(1, { state: 'timed_out' }),
      failed(2, { state: 'success' }),
      failed(3, { state: 'cancelled' }),
      { name: 'status', state: 'failure', url: 'x' },
    ];

    expect(pickExcerptJobs(checks, new Set()).map((c) => c.jobId)).toEqual([1]);
  });

  test('leaves out a check that carries its excerpt already', () => {
    expect(
      pickExcerptJobs([failed(1, { excerpt: 'boom' })], new Set()),
    ).toEqual([]);
  });

  test('leaves out a job already asked for, but it still uses a place of the five', () => {
    const checks = [1, 2, 3, 4, 5, 6].map((id) => failed(id));
    const asked = new Set([excerptKey(checks[5])]);

    expect(pickExcerptJobs(checks, asked).map((c) => c.jobId)).toEqual([
      5, 4, 3, 2,
    ]);
  });

  test('asks for nothing more once five were read, though a newer job appeared', () => {
    const checks = [3, 4, 5, 6, 7, 8].map((id) => failed(id));
    const asked = new Set([3, 4, 5, 6, 7].map((id) => excerptKey(failed(id))));

    expect(pickExcerptJobs(checks, asked)).toEqual([]);
  });

  test('asks for the places left of the five, newest first', () => {
    const checks = [3, 4, 5, 6, 7, 8].map((id) => failed(id));
    const asked = new Set([4, 5, 6].map((id) => excerptKey(failed(id))));

    expect(pickExcerptJobs(checks, asked).map((c) => c.jobId)).toEqual([8, 7]);
  });

  test('asks again for a rerun of the same job', () => {
    const first = failed(1);
    const asked = new Set([excerptKey(first)]);

    expect(pickExcerptJobs([failed(1, { runAttempt: 2 })], asked)).toHaveLength(
      1,
    );
  });
});

const answer = (status: number, body: unknown = {}) =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('fillExcerpts', () => {
  test('hands each excerpt over as it lands, in the order given', async () => {
    const got: [number | undefined, string][] = [];
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ text: 'boom', truncated: false }));
    }) as unknown as typeof fetch;

    await fillExcerpts(
      [failed(2), failed(1)],
      FORGEJO,
      (check, text) => got.push([check.jobId, text]),
      fetchImpl,
    );

    expect(got).toEqual([
      [2, 'boom'],
      [1, 'boom'],
    ]);
    expect(urls).toHaveLength(2);
  });

  test('shows nothing for a job whose log is gone or empty', async () => {
    const got: string[] = [];
    await fillExcerpts(
      [failed(1)],
      FORGEJO,
      (_c, t) => got.push(t),
      answer(404),
      () => false,
      async () => {},
    );
    await fillExcerpts(
      [failed(1)],
      FORGEJO,
      (_c, t) => got.push(t),
      answer(200, { text: '', truncated: false }),
      () => false,
      async () => {},
    );

    expect(got).toEqual([]);
  });

  test('stops at the first refusal or rate limit', async () => {
    for (const status of [401, 403, 429]) {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response('{}', { status });
      }) as unknown as typeof fetch;

      await fillExcerpts(
        [failed(1), failed(2), failed(3)],
        FORGEJO,
        () => {},
        fetchImpl,
      );

      expect(calls).toBe(1);
    }
  });

  test('a failed read does not stop the next one', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('network');
      return new Response(JSON.stringify({ text: 'boom', truncated: false }));
    }) as unknown as typeof fetch;
    const got: string[] = [];

    await fillExcerpts(
      [failed(1), failed(2)],
      FORGEJO,
      (_c, t) => got.push(t),
      fetchImpl,
      () => false,
      async () => {},
    );

    expect(got).toEqual(['boom', 'boom']);
  });

  test('stops once told the dialog moved on', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ text: 'boom', truncated: false }));
    }) as unknown as typeof fetch;

    await fillExcerpts(
      [failed(1), failed(2)],
      FORGEJO,
      () => {},
      fetchImpl,
      () => calls >= 1,
    );

    expect(calls).toBe(1);
  });

  test('asks again, at most twice, after a pause, when the first read is empty', async () => {
    let calls = 0;
    const waits: number[] = [];
    const fetchImpl = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ text: calls === 2 ? 'boom' : '', truncated: false }),
      );
    }) as unknown as typeof fetch;
    const got: string[] = [];

    await fillExcerpts(
      [failed(1)],
      FORGEJO,
      (_c, t) => got.push(t),
      fetchImpl,
      () => false,
      async (ms) => {
        waits.push(ms);
      },
    );

    expect(got).toEqual(['boom']);
    expect(calls).toBe(2);
    expect(waits).toEqual([EXCERPT_RETRY_DELAY_MS]);
  });

  test('gives up after two more tries when the log stays empty', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ text: '', truncated: false }));
    }) as unknown as typeof fetch;

    await fillExcerpts(
      [failed(1)],
      FORGEJO,
      () => {},
      fetchImpl,
      () => false,
      async () => {},
    );

    expect(calls).toBe(3);
  });

  test('retries a failed read too, and only the jobs still without text', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      const first = seen.length <= 2;
      if (url.includes('jobId=1') && first) throw new TypeError('network');
      if (url.includes('jobId=2') && first)
        return new Response(JSON.stringify({ text: 'two' }));
      return new Response(JSON.stringify({ text: 'one' }));
    }) as unknown as typeof fetch;
    const got: [number | undefined, string][] = [];

    await fillExcerpts(
      [failed(1), failed(2)],
      FORGEJO,
      (c, t) => got.push([c.jobId, t]),
      fetchImpl,
      () => false,
      async () => {},
    );

    expect(got).toEqual([
      [2, 'two'],
      [1, 'one'],
    ]);
    expect(seen).toHaveLength(3);
  });

  test('a refusal on a retry stops everything, and no retry follows one', async () => {
    for (const status of [401, 403, 429]) {
      let calls = 0;
      const waits: number[] = [];
      const fetchImpl = (async () => {
        calls++;
        return new Response('{}', { status });
      }) as unknown as typeof fetch;

      await fillExcerpts(
        [failed(1)],
        FORGEJO,
        () => {},
        fetchImpl,
        () => false,
        async (ms) => {
          waits.push(ms);
        },
      );

      expect(calls).toBe(1);
      expect(waits).toEqual([]);
    }
  });

  test('does not retry once the dialog moved on during the pause', async () => {
    let calls = 0;
    let moved = false;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ text: '' }));
    }) as unknown as typeof fetch;

    await fillExcerpts(
      [failed(1)],
      FORGEJO,
      () => {},
      fetchImpl,
      () => moved,
      async () => {
        moved = true;
      },
    );

    expect(calls).toBe(1);
  });

  test('asks GitHub for nothing', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('{}');
    }) as unknown as typeof fetch;

    await fillExcerpts([failed(1)], GITHUB, () => {}, fetchImpl);

    expect(calls).toBe(0);
  });
});
