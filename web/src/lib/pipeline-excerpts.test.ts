/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { Check } from './pipeline-checks';
import {
  EXCERPT_RETRY_DELAY_MS,
  excerptUrl,
  fillExcerpts,
  MAX_EXCERPT_READS,
  newExcerptReads,
  pickExcerptJobs,
} from './pipeline-excerpts';

const FORGEJO = { forge: 'forgejo', fullName: 'a/b' };
const GITHUB = { forge: 'github', fullName: 'a/b' };

const failed = (jobId: number, extra: Partial<Check> = {}): Check => ({
  name: `job ${jobId}`,
  status: 'completed',
  conclusion: 'failure',
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

  test('is null when no repository is named', () => {
    expect(excerptUrl(undefined, 7)).toBeNull();
  });
});

describe('pickExcerptJobs', () => {
  test('takes the newest five failed jobs that have no excerpt', () => {
    const checks = [1, 2, 3, 4, 5, 6, 7].map((id) => failed(id));

    expect(
      pickExcerptJobs(checks, newExcerptReads()).map((c) => c.jobId),
    ).toEqual([7, 6, 5, 4, 3]);
    expect(MAX_EXCERPT_READS).toBe(5);
  });

  test('takes timed out jobs, and no passed, cancelled or job-less check', () => {
    const checks = [
      failed(1, { status: 'completed', conclusion: 'timed_out' }),
      failed(2, { status: 'completed', conclusion: 'success' }),
      failed(3, { status: 'completed', conclusion: 'cancelled' }),
      { name: 'status', status: 'completed', conclusion: 'failure', url: 'x' },
    ];

    expect(
      pickExcerptJobs(checks, newExcerptReads()).map((c) => c.jobId),
    ).toEqual([1]);
  });

  test('leaves out a check that carries its excerpt already', () => {
    expect(
      pickExcerptJobs([failed(1, { excerpt: 'boom' })], newExcerptReads()),
    ).toEqual([]);
  });

  test('leaves out a job already asked for, but it still uses a place of the five', () => {
    const checks = [1, 2, 3, 4, 5, 6].map((id) => failed(id));
    const reads = newExcerptReads();
    pickExcerptJobs([checks[5]], reads);

    expect(pickExcerptJobs(checks, reads).map((c) => c.jobId)).toEqual([
      5, 4, 3, 2,
    ]);
  });

  test('asks for nothing more once five were read, though a newer job appeared', () => {
    const reads = newExcerptReads();
    pickExcerptJobs(
      [3, 4, 5, 6, 7].map((id) => failed(id)),
      reads,
    );

    expect(
      pickExcerptJobs(
        [3, 4, 5, 6, 7, 8].map((id) => failed(id)),
        reads,
      ),
    ).toEqual([]);
  });

  test('asks for the places left of the five, newest first', () => {
    const reads = newExcerptReads();
    pickExcerptJobs(
      [4, 5, 6].map((id) => failed(id)),
      reads,
    );

    expect(
      pickExcerptJobs(
        [3, 4, 5, 6, 7, 8].map((id) => failed(id)),
        reads,
      ).map((c) => c.jobId),
    ).toEqual([8, 7]);
  });

  test('a rerun of an asked job is a new read and takes a place of its own', () => {
    const reads = newExcerptReads();
    pickExcerptJobs([failed(1)], reads);

    const picked = pickExcerptJobs([failed(1, { runAttempt: 2 })], reads);

    expect(picked).toHaveLength(1);
    expect(reads.left).toBe(MAX_EXCERPT_READS - 2);
  });

  test('a job that left the list takes nothing from the places left', () => {
    const reads = newExcerptReads();
    pickExcerptJobs([failed(1), failed(2)], reads);

    // Only the places spent count, whatever the list holds now.
    expect(reads.left).toBe(MAX_EXCERPT_READS - 2);
    expect(pickExcerptJobs([], reads)).toEqual([]);
    expect(reads.left).toBe(MAX_EXCERPT_READS - 2);
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

  test('a job with no log address is skipped and the others still get theirs', async () => {
    const got: [number | undefined, string][] = [];
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ text: 'boom', truncated: false }));
    }) as unknown as typeof fetch;
    const noAddress = { ...failed(9), jobId: undefined };

    await fillExcerpts(
      [failed(2), noAddress, failed(1)],
      FORGEJO,
      (check, text) => got.push([check.jobId, text]),
      fetchImpl,
    );

    expect(got).toEqual([
      [2, 'boom'],
      [1, 'boom'],
    ]);
    expect(urls).toHaveLength(2);
    expect(urls.some((u) => u.includes('undefined'))).toBe(false);
  });

  test('a skipped job costs no retry read', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ text: '', truncated: false }));
    }) as unknown as typeof fetch;
    const reads = newExcerptReads();
    reads.left = 1;

    await fillExcerpts(
      [{ ...failed(9), jobId: undefined }, failed(1)],
      FORGEJO,
      () => {},
      fetchImpl,
      () => false,
      async () => {},
      reads,
    );

    // The one retry read left goes to job 1, not to the skipped job.
    expect(urls).toHaveLength(2);
    expect(reads.left).toBe(0);
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

    expect(got).toEqual(['boom']);
    expect(calls).toBe(2);
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

  test('retries only the jobs whose log came back empty, not a failed read', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url.includes('jobId=1')) throw new TypeError('network');
      if (url.includes('jobId=3')) return new Response('{}', { status: 500 });
      const empty = seen.filter((u) => u.includes('jobId=2')).length === 1;
      return new Response(JSON.stringify({ text: empty ? '' : 'two' }));
    }) as unknown as typeof fetch;
    const got: [number | undefined, string][] = [];

    await fillExcerpts(
      [failed(1), failed(2), failed(3)],
      FORGEJO,
      (c, t) => got.push([c.jobId, t]),
      fetchImpl,
      () => false,
      async () => {},
    );

    expect(got).toEqual([[2, 'two']]);
    expect(seen.filter((u) => u.includes('jobId=1'))).toHaveLength(1);
    expect(seen.filter((u) => u.includes('jobId=3'))).toHaveLength(1);
    expect(seen.filter((u) => u.includes('jobId=2'))).toHaveLength(2);
  });

  test('retries spend the five reads of one open, so they never pass five', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ text: '' }));
    }) as unknown as typeof fetch;
    const reads = newExcerptReads();
    const picks = pickExcerptJobs(
      [1, 2, 3, 4, 5, 6].map((id) => failed(id)),
      reads,
    );

    await fillExcerpts(
      picks,
      FORGEJO,
      () => {},
      fetchImpl,
      () => false,
      async () => {},
      reads,
    );

    expect(calls).toBe(MAX_EXCERPT_READS);
  });

  test('retries spend from the reads left, so three empty jobs make five reads', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ text: '' }));
    }) as unknown as typeof fetch;
    const reads = newExcerptReads();
    const picks = pickExcerptJobs(
      [1, 2, 3].map((id) => failed(id)),
      reads,
    );

    await fillExcerpts(
      picks,
      FORGEJO,
      () => {},
      fetchImpl,
      () => false,
      async () => {},
      reads,
    );

    expect(calls).toBe(MAX_EXCERPT_READS);
    expect(reads.left).toBe(0);
  });

  test('an answer that is not JSON with text is not retried', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('<html>proxy</html>');
    }) as unknown as typeof fetch;

    await fillExcerpts(
      [failed(1)],
      FORGEJO,
      () => {},
      fetchImpl,
      () => false,
      async () => {},
    );

    expect(calls).toBe(1);
  });

  test('a retry takes the places two overlapping runs have left between them', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ text: '' }));
    }) as unknown as typeof fetch;
    const reads = newExcerptReads();
    const none = async () => {};
    const run = (list: Check[]) =>
      fillExcerpts(
        pickExcerptJobs(list, reads),
        FORGEJO,
        () => {},
        fetchImpl,
        () => false,
        none,
        reads,
      );

    await Promise.all([
      run([1, 2, 3].map((id) => failed(id))),
      run([4, 5, 6].map((id) => failed(id))),
    ]);

    expect(calls).toBe(MAX_EXCERPT_READS);
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
