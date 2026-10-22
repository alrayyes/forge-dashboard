/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  copyLog,
  type LogResult,
  loadRunLog,
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
