/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  copyLog,
  copyPending,
  copyStatus,
  type LogResult,
  loadRunLog,
  logToCopy,
  logUrl,
  notePlaces,
} from './run-log';

describe('logUrl', () => {
  test('takes the forge and repository from the checks url', () => {
    expect(
      logUrl(
        '/api/pull-requests/checks?forge=github&fullName=a%2Fb&number=4',
        31,
      ),
    ).toBe('/api/checks/log?forge=github&fullName=a%2Fb&jobId=31');
  });

  test('works for a branch checks url', () => {
    expect(
      logUrl('/api/main-branches/checks?forge=forgejo&fullName=a%2Fb', 7),
    ).toBe('/api/checks/log?forge=forgejo&fullName=a%2Fb&jobId=7');
  });

  test('is null when the checks url names no repository', () => {
    expect(logUrl('/api/pull-requests/checks', 7)).toBeNull();
  });
});

const respond = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

describe('loadRunLog', () => {
  test('returns the text and whether it was cut', async () => {
    const got = await loadRunLog(
      '/x',
      'GitHub',
      respond(200, { text: 'ok\n', truncated: true }),
    );
    expect(got).toEqual({ ok: true, text: 'ok\n', truncated: true });
  });

  test('says what a refusal means in plain words, naming the forge', async () => {
    const got = (await loadRunLog(
      '/x',
      'GitHub',
      respond(403, { error: 'raw 403 body' }),
    )) as Extract<LogResult, { ok: false }>;
    expect(got.ok).toBe(false);
    expect(got.message).toContain("can't read");
    expect(got.message).toContain('GitHub');
    expect(got.message).not.toContain('raw 403 body');
  });

  test('a missing log says it may have expired', async () => {
    const got = (await loadRunLog(
      '/x',
      'Forgejo',
      respond(404, { error: 'x' }),
    )) as Extract<LogResult, { ok: false }>;
    expect(got.message).toContain('Forgejo');
    expect(got.message).toContain('expired');
  });

  test('a rate limit says to try again', async () => {
    const got = (await loadRunLog('/x', 'GitHub', respond(429, {}))) as Extract<
      LogResult,
      { ok: false }
    >;
    expect(got.message).toContain('try again');
  });

  test('a network failure is a message, not a throw', async () => {
    const got = (await loadRunLog('/x', 'GitHub', (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch)) as Extract<LogResult, { ok: false }>;
    expect(got.ok).toBe(false);
    expect(got.message).toContain('offline');
  });

  test('a signed-out answer is reported so the caller can sign in', async () => {
    const got = await loadRunLog('/x', 'GitHub', respond(401, {}));
    expect(got).toEqual({
      ok: false,
      signedOut: true,
      message: 'Your session ended. Sign in again.',
    });
  });
});

describe('notePlaces', () => {
  test('says how much was kept', () => {
    expect(notePlaces('GitHub')).toContain('last 256 KB');
    expect(notePlaces('GitHub')).toContain('GitHub');
  });
});

describe('copyLog', () => {
  test('copied through the clipboard', async () => {
    const written: string[] = [];
    const got = await copyLog('text', {
      clipboard: { writeText: async (t: string) => void written.push(t) },
      select: () => false,
    });
    expect(got).toBe('copied');
    expect(written).toEqual(['text']);
  });

  test('falls back to the selection copy when the clipboard refuses', async () => {
    const got = await copyLog('text', {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
      select: () => true,
    });
    expect(got).toBe('copied');
  });

  test('falls back when there is no async clipboard at all', async () => {
    const got = await copyLog('text', {
      clipboard: undefined,
      select: () => true,
    });
    expect(got).toBe('copied');
  });

  test('when nothing can copy, the text is left selected and the caller says so', async () => {
    const got = await copyLog('text', {
      clipboard: undefined,
      select: () => false,
    });
    expect(got).toBe('selected');
  });
});

const URL9 = '/api/checks/log?forge=github&fullName=a%2Fb&jobId=9';

describe('logToCopy', () => {
  test('is the whole log when the endpoint answers', async () => {
    const got = await logToCopy(
      URL9,
      'tail',
      'GitHub',
      respond(200, { text: 'all\n', truncated: false }),
    );

    expect(got).toEqual({ text: 'all\n', kind: 'whole', why: '' });
  });

  test('says when the server cut the log', async () => {
    const got = await logToCopy(
      URL9,
      'tail',
      'GitHub',
      respond(200, { text: 'end\n', truncated: true }),
    );

    expect(got.kind).toBe('cut');
  });

  test('is the excerpt, with the reason, when the log cannot be read', async () => {
    const got = await logToCopy(URL9, 'tail', 'GitHub', respond(403, {}));

    expect(got.text).toBe('tail');
    expect(got.kind).toBe('excerpt');
    expect(got.why).toContain("can't read this job's output");
  });

  test('asks for a new sign-in on a 401', async () => {
    const got = await logToCopy(URL9, 'tail', 'GitHub', respond(401, {}));

    expect(got.why).toBe('Your session ended. Sign in again.');
  });

  test('says there is no job when there is no log url', async () => {
    const got = await logToCopy(null, 'tail', 'GitHub');

    expect(got).toMatchObject({ text: 'tail', kind: 'excerpt' });
    expect(got.why).toContain('no job');
  });
});

describe('copyStatus', () => {
  const whole = { text: 'x', kind: 'whole', why: '' } as const;
  const excerpt = { text: 'x', kind: 'excerpt', why: 'Gone.' } as const;

  test('plain Copied only for a whole log that landed', () => {
    expect(copyStatus('copied', whole, 'GitHub')).toBe('Copied');
  });

  test('a cut log says so', () => {
    expect(copyStatus('copied', { ...whole, kind: 'cut' }, 'GitHub')).toContain(
      'last 256 KB',
    );
  });

  test('an excerpt says it is only the excerpt, and why', () => {
    expect(copyStatus('copied', excerpt, 'GitHub')).toBe(
      'Copied the excerpt only. Gone.',
    );
  });

  test('a refused copy of a whole log says the full log was not copied', () => {
    expect(copyStatus('selected', whole, 'GitHub')).toContain(
      'full log was not copied',
    );
  });
});

describe('copyPending', () => {
  const ready = Promise.resolve({
    text: 'full',
    kind: 'whole' as const,
    why: '',
  });

  test('hands the clipboard the promise before the text is known', async () => {
    const written: unknown[] = [];
    const out = await copyPending(ready, {
      clipboard: {
        writeText: async () => {
          throw new Error('not used');
        },
        write: async (items) => {
          written.push(...items);
        },
      },
      makeItem: (text) => ({ text }),
      select: () => false,
    });

    expect(out.outcome).toBe('copied');
    expect(written).toHaveLength(1);
    expect(await (written[0] as { text: Promise<string> }).text).toBe('full');
  });

  test('copies the same text another way when the item write is refused', async () => {
    const wrote: string[] = [];
    const out = await copyPending(ready, {
      clipboard: {
        writeText: async (t) => {
          wrote.push(t);
        },
        write: async () => {
          throw new Error('refused');
        },
      },
      makeItem: (text) => ({ text }),
      select: () => false,
    });

    expect(wrote).toEqual(['full']);
    expect(out.outcome).toBe('copied');
  });

  test('selects the text itself when no clipboard works', async () => {
    const selected: string[] = [];
    const out = await copyPending(ready, {
      select: (t) => {
        selected.push(t);
        return true;
      },
    });

    expect(selected).toEqual(['full']);
    expect(out.outcome).toBe('copied');
  });
});
