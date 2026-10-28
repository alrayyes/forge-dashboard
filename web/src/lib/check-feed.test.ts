/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import {
  type CheckFeedMessage,
  createCheckFeed,
  type FeedSource,
  type Subject,
} from './check-feed';

// The job list of a pull request or branch rides the dashboard stream as
// named "run" events, one for each workflow run attempt. A page asks for the
// lists it shows by posting its watch, and the server sends them again on
// every change.

class FakeSource implements FeedSource {
  handlers = new Map<string, ((event: { data?: string }) => void)[]>();
  readyState = 0;
  addEventListener(type: string, fn: (event: { data?: string }) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  emitRaw(type: string, data?: string) {
    for (const fn of this.handlers.get(type) ?? []) fn({ data });
  }
  emit(type: string, data?: unknown) {
    this.emitRaw(type, data === undefined ? undefined : JSON.stringify(data));
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
}

const pr: Subject = {
  kind: 'pull_request',
  forge: 'github',
  fullName: 'a/b',
  number: 7,
};
const branch: Subject = {
  kind: 'main_branch',
  forge: 'forgejo',
  fullName: 'a/c',
};

type Post = { streamId: string; subjects: Subject[]; refresh?: boolean };

function harness(status = 204, timeoutMs = 60000) {
  const posts: Post[] = [];
  const redirects: string[] = [];
  const feed = createCheckFeed({
    newId: () => 'stream-0001',
    post: async (body) => {
      posts.push(JSON.parse(body));
      return status;
    },
    unauthorized: () => redirects.push('login'),
    timeoutMs,
  });
  const source = new FakeSource();
  feed.attach(source);
  return { feed, source, posts, redirects };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('streamUrl', () => {
  test('names the connection after the feed', () => {
    const { feed } = harness();
    expect(feed.streamUrl('/api/dashboard/stream')).toBe(
      '/api/dashboard/stream?sid=stream-0001',
    );
  });

  test('appends to a url that already has a query', () => {
    const { feed } = harness();
    expect(feed.streamUrl('/api/dashboard/stream?drafts=1')).toBe(
      '/api/dashboard/stream?drafts=1&sid=stream-0001',
    );
  });
});

describe('watch', () => {
  test('posts the watch once the stream is open', async () => {
    const { feed, source, posts } = harness();
    feed.watch(pr, () => {});
    await flush();
    expect(posts).toEqual([]);
    source.open();
    await flush();
    expect(posts).toEqual([{ streamId: 'stream-0001', subjects: [pr] }]);
  });

  test('posts straight away on an open stream', async () => {
    const { feed, source, posts } = harness();
    source.open();
    feed.watch(pr, () => {});
    await flush();
    expect(posts).toEqual([{ streamId: 'stream-0001', subjects: [pr] }]);
  });

  test('posts the watch again when the stream reopens', async () => {
    const { feed, source, posts } = harness();
    source.open();
    feed.watch(pr, () => {});
    await flush();
    source.open();
    await flush();
    expect(posts).toHaveLength(2);
  });

  test('hands a run event to the listener of its subject only', () => {
    const { feed, source } = harness();
    const prGot: CheckFeedMessage[] = [];
    const branchGot: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => prGot.push(m));
    feed.watch(branch, (m) => branchGot.push(m));
    const build = {
      name: 'build',
      status: 'completed',
      conclusion: 'success',
      url: '',
    };
    source.emit('run', {
      ...pr,
      key: 'job/|build',
      checks: [build],
      final: true,
    });
    expect(prGot).toEqual([{ checks: [build] }]);
    expect(branchGot).toEqual([]);
  });

  // The server lists a subject once, to the first watcher. A second one (a
  // dialog opened on a row the page already watches) must not wait for the
  // next change to see the list.
  describe('a second listener on a subject already listed', () => {
    const build = {
      name: 'build',
      status: 'completed',
      conclusion: 'success',
      url: '',
    };
    const listed = (source: FakeSource) =>
      source.emit('run', {
        ...pr,
        key: 'job/|build',
        checks: [build],
        final: true,
      });

    test('is handed the list held, and no second watch is posted', async () => {
      const { feed, source, posts } = harness();
      source.open();
      feed.watch(pr, () => {});
      listed(source);
      await flush();
      const got: CheckFeedMessage[] = [];

      feed.watch(pr, (m) => got.push(m));
      await flush();

      expect(got).toEqual([{ checks: [build] }]);
      expect(posts).toHaveLength(1);
    });

    test('hears the next change too', async () => {
      const { feed, source } = harness();
      source.open();
      feed.watch(pr, () => {});
      listed(source);
      const got: CheckFeedMessage[] = [];
      feed.watch(pr, (m) => got.push(m));
      await flush();

      listed(source);

      expect(got).toHaveLength(2);
    });

    test('is told why when the read failed', async () => {
      const { feed, source } = harness();
      source.open();
      feed.watch(pr, () => {});
      source.emit('run', { ...pr, error: 'token cannot read checks' });
      const got: CheckFeedMessage[] = [];

      feed.watch(pr, (m) => got.push(m));
      await flush();

      expect(got).toEqual([{ error: 'token cannot read checks' }]);
    });

    test('waits for the list when none has arrived yet', async () => {
      const { feed, source } = harness();
      source.open();
      feed.watch(pr, () => {});
      const got: CheckFeedMessage[] = [];

      feed.watch(pr, (m) => got.push(m));
      await flush();

      expect(got).toEqual([]);
    });
  });

  describe('assembling run events', () => {
    const job = (name: string, status = 'completed', extra = {}) => ({
      name,
      status,
      url: `u/${name}`,
      ...extra,
    });

    test('tells the listener once, when the last event of a listing arrives', () => {
      const { feed, source } = harness();
      const got: CheckFeedMessage[] = [];
      feed.watch(pr, (m) => got.push(m));
      source.emit('run', {
        ...pr,
        key: 'run/11/1',
        runId: 11,
        checks: [job('build')],
      });
      source.emit('run', {
        ...pr,
        key: 'run/12/1',
        runId: 12,
        checks: [job('lint')],
        final: true,
      });
      expect(got).toEqual([{ checks: [job('build'), job('lint')] }]);
    });

    test('a rerun replaces its attempt and keeps its place', () => {
      const { feed, source } = harness();
      const got: CheckFeedMessage[] = [];
      feed.watch(pr, (m) => got.push(m));
      source.emit('run', {
        ...pr,
        key: 'run/11/1',
        runId: 11,
        runAttempt: 1,
        checks: [job('build', 'completed', { conclusion: 'failure' })],
      });
      source.emit('run', {
        ...pr,
        key: 'run/12/1',
        runId: 12,
        checks: [job('lint')],
        final: true,
      });
      source.emit('run', {
        ...pr,
        key: 'run/11/2',
        runId: 11,
        runAttempt: 2,
        checks: [job('build', 'in_progress')],
      });
      source.emit('run', {
        ...pr,
        key: 'run/11/1',
        gone: true,
        final: true,
      });
      expect(got.at(-1)).toEqual({
        checks: [job('lint'), job('build', 'in_progress')],
      });
    });

    test('keeps the facts a run event carries, as the server sent them', () => {
      const { feed, source } = harness();
      const got: CheckFeedMessage[] = [];
      feed.watch(pr, (m) => got.push(m));
      source.emit('run', {
        ...pr,
        key: 'run/11/2',
        runId: 11,
        runAttempt: 2,
        status: 'completed',
        conclusion: 'failure',
        startedAt: '2026-10-27T10:00:00Z',
        completedAt: '2026-10-27T10:05:00Z',
        checks: [job('build', 'completed', { conclusion: 'success' })],
      });
      source.emit('run', {
        ...pr,
        key: 'job/u|lint',
        checks: [job('lint')],
        final: true,
      });
      expect(got).toEqual([
        {
          checks: [
            job('build', 'completed', { conclusion: 'success' }),
            job('lint'),
          ],
          runs: [
            {
              runId: 11,
              runAttempt: 2,
              status: 'completed',
              conclusion: 'failure',
              startedAt: '2026-10-27T10:00:00Z',
              completedAt: '2026-10-27T10:05:00Z',
            },
          ],
        },
      ]);
    });

    test('a run event with no facts adds none', () => {
      const { feed, source } = harness();
      const got: CheckFeedMessage[] = [];
      feed.watch(pr, (m) => got.push(m));
      source.emit('run', {
        ...pr,
        key: 'run/11/1',
        runId: 11,
        runAttempt: 1,
        checks: [job('build')],
        final: true,
      });
      expect(got).toEqual([{ checks: [job('build')] }]);
      expect('runs' in got[0]).toBe(false);
    });

    test('a rerun replaces the facts of its attempt, and a gone run drops them', () => {
      const { feed, source } = harness();
      const got: CheckFeedMessage[] = [];
      feed.watch(pr, (m) => got.push(m));
      source.emit('run', {
        ...pr,
        key: 'run/11/1',
        runId: 11,
        runAttempt: 1,
        status: 'completed',
        conclusion: 'failure',
        checks: [job('build')],
        final: true,
      });
      source.emit('run', {
        ...pr,
        key: 'run/11/2',
        runId: 11,
        runAttempt: 2,
        status: 'in_progress',
        checks: [job('build', 'in_progress')],
      });
      source.emit('run', {
        ...pr,
        key: 'run/11/1',
        gone: true,
        final: true,
      });
      expect(got.at(-1)).toEqual({
        checks: [job('build', 'in_progress')],
        runs: [{ runId: 11, runAttempt: 2, status: 'in_progress' }],
      });
    });

    test('a gone run is dropped, and an empty listing clears the rest', () => {
      const { feed, source } = harness();
      const got: CheckFeedMessage[] = [];
      feed.watch(pr, (m) => got.push(m));
      source.emit('run', {
        ...pr,
        key: 'run/11/1',
        runId: 11,
        checks: [job('build')],
        final: true,
      });
      source.emit('run', { ...pr, final: true });
      expect(got).toEqual([{ checks: [job('build')] }, { checks: [] }]);
    });

    test('a run missed during an outage does not outlive the reconnect', () => {
      const { feed, source } = harness();
      const got: CheckFeedMessage[] = [];
      feed.watch(pr, (m) => got.push(m));
      source.emit('run', {
        ...pr,
        key: 'run/11/1',
        runId: 11,
        checks: [job('old')],
        final: true,
      });
      source.emit('error');
      // The server starts a new connection with nothing sent, so it never
      // says that run/11/1 is gone.
      source.open();
      source.emit('run', {
        ...pr,
        key: 'run/11/2',
        runId: 11,
        checks: [job('new')],
        final: true,
      });
      expect(got.at(-1)).toEqual({ checks: [job('new')] });
    });

    test('a failed listing is not mixed into the next one', () => {
      const { feed, source } = harness();
      const got: CheckFeedMessage[] = [];
      feed.watch(pr, (m) => got.push(m));
      source.emit('run', {
        ...pr,
        key: 'run/11/1',
        runId: 11,
        checks: [job('old')],
        final: true,
      });
      source.emit('run', { ...pr, error: 'forge said no' });
      source.emit('run', {
        ...pr,
        key: 'run/12/1',
        runId: 12,
        checks: [job('new')],
        final: true,
      });
      expect(got.at(-1)).toEqual({ checks: [job('new')] });
    });

    test('a late event for a subject nobody watches is dropped', () => {
      const { feed, source } = harness();
      const unwatch = feed.watch(pr, () => {});
      unwatch();
      source.emit('run', {
        ...pr,
        key: 'run/11/1',
        runId: 11,
        checks: [job('late')],
      });
      const got: CheckFeedMessage[] = [];
      feed.watch(pr, (m) => got.push(m));
      source.emit('run', {
        ...pr,
        key: 'run/12/1',
        runId: 12,
        checks: [job('fresh')],
        final: true,
      });
      expect(got).toEqual([{ checks: [job('fresh')] }]);
    });

    test('a run keeps its place when a rerun replaces its attempt in the list', () => {
      const { feed, source } = harness();
      const got: CheckFeedMessage[] = [];
      feed.watch(pr, (m) => got.push(m));
      for (const [id, name] of [
        [11, 'build'],
        [12, 'lint'],
      ] as const)
        source.emit('run', {
          ...pr,
          key: `run/${id}/1`,
          runId: id,
          checks: [job(name)],
        });
      source.emit('run', {
        ...pr,
        key: 'run/11/1',
        runId: 11,
        checks: [job('build', 'in_progress')],
        final: true,
      });
      // The same key is replaced where it stood. A new attempt has a new
      // key, so it goes last, as in the rerun test above.
      expect(got.at(-1)).toEqual({
        checks: [job('build', 'in_progress'), job('lint')],
      });
    });

    test('holds a listing back from a subject that is not the one it names', () => {
      const { feed, source } = harness();
      const prGot: CheckFeedMessage[] = [];
      const branchGot: CheckFeedMessage[] = [];
      feed.watch(pr, (m) => prGot.push(m));
      feed.watch(branch, (m) => branchGot.push(m));
      source.emit('run', {
        ...branch,
        key: 'run/1/1',
        checks: [job('build')],
        final: true,
      });
      expect(prGot).toEqual([]);
      expect(branchGot).toEqual([{ checks: [job('build')] }]);
    });
  });

  test('hands over the error of a failed list', () => {
    const { feed, source } = harness();
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    source.emit('run', { ...pr, error: 'forge said no' });
    expect(got).toEqual([{ error: 'forge said no' }]);
  });

  test('ignores a malformed event', () => {
    const { feed, source } = harness();
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    source.emitRaw('run', '{nope');
    expect(got).toEqual([]);
  });

  test('stops telling a listener that unsubscribed, and posts what is left', async () => {
    const { feed, source, posts } = harness();
    source.open();
    const got: CheckFeedMessage[] = [];
    const stop = feed.watch(pr, (m) => got.push(m));
    feed.watch(branch, () => {});
    await flush();
    stop();
    await flush();
    source.emit('run', { ...pr, final: true });
    expect(got).toEqual([]);
    expect(posts.at(-1)?.subjects).toEqual([branch]);
  });

  test('tells the listeners when the stream errors', () => {
    const { feed, source } = harness();
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    source.emit('error');
    expect(got).toEqual([{ error: 'the live connection is down' }]);
  });

  test('waits for a stream that is still connecting', async () => {
    const { feed } = harness();
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    await flush();
    expect(got).toEqual([]);
  });

  test('tells the listener when the watch is refused', async () => {
    const { feed, source } = harness(404);
    source.open();
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    await flush();
    expect(got).toEqual([{ error: 'the live connection is down' }]);
  });

  test('sends a signed-out page to the login', async () => {
    const { feed, source, redirects } = harness(401);
    source.open();
    feed.watch(pr, () => {});
    await flush();
    expect(redirects).toEqual(['login']);
  });
});

describe('refresh', () => {
  test('asks for the list again and resolves on the next event', async () => {
    const { feed, source, posts } = harness();
    source.open();
    feed.watch(pr, () => {});
    await flush();
    const done = feed.refresh(pr);
    await flush();
    expect(posts.at(-1)).toEqual({
      streamId: 'stream-0001',
      subjects: [pr],
      refresh: true,
    });
    source.emit('run', { ...pr, final: true });
    expect(await done).toBe(true);
  });

  test('resolves false when the list failed', async () => {
    const { feed, source } = harness();
    source.open();
    feed.watch(pr, () => {});
    const done = feed.refresh(pr);
    await flush();
    source.emit('run', { ...pr, error: 'x' });
    expect(await done).toBe(false);
  });

  test('resolves false when nothing comes back in time', async () => {
    const { feed, source } = harness(204, 0);
    source.open();
    feed.watch(pr, () => {});
    expect(await feed.refresh(pr)).toBe(false);
  });
});

describe('watch while a refresh is out', () => {
  test('a dialog closed during a refresh stops the watch, and reopening posts it again', async () => {
    const { feed, source, posts } = harness();
    source.open();
    const stop = feed.watch(pr, () => {});
    await flush();
    void feed.refresh(pr);
    stop();
    await flush();
    expect(posts.at(-1)?.subjects).toEqual([]);
    feed.watch(pr, () => {});
    await flush();
    expect(posts.at(-1)?.subjects).toEqual([pr]);
  });
});

describe('without a stream', () => {
  test('a closed stream tells the listener the connection is down', async () => {
    const { feed, source, posts } = harness();
    source.readyState = 2;
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    await flush();
    expect(got).toEqual([{ error: 'the live connection is down' }]);
    expect(posts).toEqual([]);
  });

  test('a page with no stream yet waits, then gives up', async () => {
    const feed = createCheckFeed({ newId: () => 'x', timeoutMs: 0 });
    const got: CheckFeedMessage[] = [];
    feed.watch(branch, (m) => got.push(m));
    await flush();
    expect(got).toEqual([{ error: 'no answer from the server' }]);
  });

  test('a stream that closes for good tells its watchers', async () => {
    const { feed, source } = harness();
    source.open();
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    await flush();
    source.readyState = 2;
    source.emit('error');
    expect(got).toEqual([{ error: 'the live connection is down' }]);
  });

  test('refresh resolves false', async () => {
    const { feed, source } = harness();
    source.readyState = 2;
    expect(await feed.refresh(pr)).toBe(false);
  });
});

describe('read', () => {
  const list = [
    { name: 'build', status: 'completed', conclusion: 'success', url: 'u' },
  ];

  test('watches the subject, resolves with its list and lets go', async () => {
    const { feed, source, posts } = harness();
    source.open();
    const done = feed.read(pr);
    await flush();
    expect(posts.at(-1)?.subjects).toEqual([pr]);
    source.emit('run', {
      ...pr,
      key: 'job/u|build',
      checks: list,
      final: true,
    });
    expect(await done).toEqual({ checks: list });
    await flush();
    expect(posts.at(-1)?.subjects).toEqual([]);
  });

  test('asks for a fresh list of a subject that is already watched', async () => {
    const { feed, source, posts } = harness();
    source.open();
    feed.watch(pr, () => {});
    await flush();
    const done = feed.read(pr);
    await flush();
    expect(posts.at(-1)).toEqual({
      streamId: 'stream-0001',
      subjects: [pr],
      refresh: true,
    });
    source.emit('run', {
      ...pr,
      key: 'job/u|build',
      checks: list,
      final: true,
    });
    expect(await done).toEqual({ checks: list });
    expect(posts.at(-1)?.subjects).toEqual([pr]);
  });

  test('hands over why a list failed', async () => {
    const { feed, source } = harness();
    source.open();
    const done = feed.read(pr);
    await flush();
    source.emit('run', { ...pr, error: 'forge unreachable' });
    expect(await done).toEqual({ error: 'forge unreachable' });
  });

  test('says the connection is down without a stream', async () => {
    const { feed, source } = harness();
    source.readyState = 2;
    expect(await feed.read(pr)).toEqual({
      error: 'the live connection is down',
    });
  });

  test('gives up when nothing comes back in time', async () => {
    const { feed, source } = harness(204, 0);
    source.open();
    expect(await feed.read(pr)).toEqual({ error: 'no answer from the server' });
  });

  test('waits for a stream that is not attached yet', async () => {
    const posts: Post[] = [];
    const feed = createCheckFeed({
      newId: () => 'stream-0001',
      post: async (body) => {
        posts.push(JSON.parse(body));
        return 204;
      },
      timeoutMs: 60000,
    });
    const done = feed.read(pr);
    const source = new FakeSource();
    feed.attach(source);
    source.open();
    await flush();
    expect(posts.at(-1)?.subjects).toEqual([pr]);
    source.emit('run', {
      ...pr,
      key: 'job/u|build',
      checks: list,
      final: true,
    });
    expect(await done).toEqual({ checks: list });
  });

  test('gives up on a stream that never attaches', async () => {
    const feed = createCheckFeed({ newId: () => 'x', timeoutMs: 0 });
    expect(await feed.read(pr)).toEqual({ error: 'no answer from the server' });
  });
});

describe('a stream that never answers', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('a watch with no list in time tells the listener', () => {
    const { feed } = harness(204, 5000);
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    jest.advanceTimersByTime(4999);
    expect(got).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(got).toEqual([{ error: 'no answer from the server' }]);
  });

  test('a list in time cancels the wait', () => {
    const { feed, source } = harness(204, 5000);
    source.open();
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    source.emit('run', { ...pr, final: true });
    jest.advanceTimersByTime(60000);
    expect(got).toEqual([{ checks: [] }]);
  });

  test('a stream that comes back still delivers the list', () => {
    const { feed, source } = harness(204, 5000);
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    jest.advanceTimersByTime(5000);
    source.open();
    source.emit('run', { ...pr, final: true });
    expect(got.at(-1)).toEqual({ checks: [] });
  });

  test('stopping the watch cancels the wait', () => {
    const { feed } = harness(204, 5000);
    const got: CheckFeedMessage[] = [];
    const stop = feed.watch(pr, (m) => got.push(m));
    stop();
    jest.advanceTimersByTime(60000);
    expect(got).toEqual([]);
  });
});
