/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  type CheckFeedMessage,
  createCheckFeed,
  type FeedSource,
  type Subject,
} from './check-feed';

// The job list of a pull request or branch rides the dashboard stream as a
// named "checks" event. A page asks for the lists it shows by posting its
// watch, and the server sends one back on every change.

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
  const reads: Subject[] = [];
  const answers: CheckFeedMessage[] = [];
  const feed = createCheckFeed({
    read: async (subject) => {
      reads.push(subject);
      return (
        answers.shift() ?? {
          checks: [{ name: 'read', state: 'success', url: 'u' }],
        }
      );
    },
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
  return { feed, source, posts, redirects, reads, answers };
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

  test('hands a checks event to the listener of its subject only', () => {
    const { feed, source } = harness();
    const prGot: CheckFeedMessage[] = [];
    const branchGot: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => prGot.push(m));
    feed.watch(branch, (m) => branchGot.push(m));
    const build = { name: 'build', state: 'success', url: '' };
    source.emit('checks', { ...pr, checks: [build] });
    expect(prGot).toEqual([{ checks: [build] }]);
    expect(branchGot).toEqual([]);
  });

  test('hands over the error of a failed list', () => {
    const { feed, source } = harness();
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    source.emit('checks', { ...pr, checks: null, error: 'forge said no' });
    expect(got).toEqual([{ error: 'forge said no' }]);
  });

  test('ignores a malformed event', () => {
    const { feed, source } = harness();
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    source.emitRaw('checks', '{nope');
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
    source.emit('checks', { ...pr, checks: [] });
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
    source.emit('checks', { ...pr, checks: [] });
    expect(await done).toBe(true);
  });

  test('resolves false when the list failed', async () => {
    const { feed, source } = harness();
    source.open();
    feed.watch(pr, () => {});
    const done = feed.refresh(pr);
    await flush();
    source.emit('checks', { ...pr, checks: null, error: 'x' });
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
  const list = [{ name: 'read', state: 'success', url: 'u' }];

  test('a closed stream is read once for the list', async () => {
    const { feed, source, reads, posts } = harness();
    source.readyState = 2;
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    await flush();
    expect(reads).toEqual([pr]);
    expect(got).toEqual([{ checks: list }]);
    expect(posts).toEqual([]);
  });

  test('a page with no stream at all reads too', async () => {
    const feed = createCheckFeed({
      newId: () => 'x',
      read: async () => ({ checks: [] }),
    });
    const got: CheckFeedMessage[] = [];
    feed.watch(branch, (m) => got.push(m));
    await flush();
    expect(got).toEqual([{ checks: [] }]);
  });

  test('a stream that closes for good hands its watchers a read', async () => {
    const { feed, source, reads } = harness();
    source.open();
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    await flush();
    source.readyState = 2;
    source.emit('error');
    await flush();
    expect(reads).toEqual([pr]);
    expect(got).toEqual([{ checks: list }]);
  });

  test('a failed read tells the listener why', async () => {
    const { feed, source, answers } = harness();
    source.readyState = 2;
    answers.push({ error: 'forge unreachable' });
    const got: CheckFeedMessage[] = [];
    feed.watch(pr, (m) => got.push(m));
    await flush();
    expect(got).toEqual([{ error: 'forge unreachable' }]);
  });

  test('refresh reads again and resolves true on a list', async () => {
    const { feed, source, reads } = harness();
    source.readyState = 2;
    feed.watch(pr, () => {});
    await flush();
    expect(await feed.refresh(pr)).toBe(true);
    expect(reads).toEqual([pr, pr]);
  });

  test('refresh resolves false when the read failed, and the next one works', async () => {
    const { feed, source, answers } = harness();
    source.readyState = 2;
    feed.watch(pr, () => {});
    await flush();
    answers.push({ error: 'x' });
    expect(await feed.refresh(pr)).toBe(false);
    expect(await feed.refresh(pr)).toBe(true);
  });
});
