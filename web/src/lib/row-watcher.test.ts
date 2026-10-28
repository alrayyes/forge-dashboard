/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { CheckFeedMessage, Subject } from './check-feed';
import { createRowWatcher } from './row-watcher';

// A page watches the rows it shows. Rows come and go as the filter or the data
// changes, so the watcher keeps what it already follows and swaps the rest.

const subject = (fullName: string): Subject => ({
  kind: 'main_branch',
  forge: 'github',
  fullName,
});

function harness() {
  const live = new Map<string, (message: CheckFeedMessage) => void>();
  const log: string[] = [];
  const told = new Map<string, unknown>();
  const watcher = createRowWatcher({
    feed: {
      watch(s, follower) {
        log.push(`watch ${s.fullName}`);
        live.set(s.fullName, follower);
        return () => {
          log.push(`stop ${s.fullName}`);
          live.delete(s.fullName);
        };
      },
    },
    onChecks: (key, checks) => told.set(key, checks),
    onDrop: (key) => told.delete(key),
  });

  return { watcher, live, log, told };
}

describe('createRowWatcher', () => {
  test('watches each subject once', () => {
    const { watcher, log } = harness();

    watcher.set([subject('a/one'), subject('a/two')]);
    watcher.set([subject('a/one'), subject('a/two')]);

    expect(log).toEqual(['watch a/one', 'watch a/two']);
  });

  test('swaps only the subjects that changed', () => {
    const { watcher, log } = harness();

    watcher.set([subject('a/one'), subject('a/two')]);
    log.length = 0;
    watcher.set([subject('a/two'), subject('a/three')]);

    expect(log).toEqual(['watch a/three', 'stop a/one']);
  });

  test('hands a subject its job list under the row key', () => {
    const { watcher, live, told } = harness();
    const checks = [{ name: 'build' }];

    watcher.set([subject('a/one')]);
    live.get('a/one')?.({ checks } as CheckFeedMessage);

    expect(told.get('github:a/one')).toBe(checks);
  });

  test('an error is no job list', () => {
    const { watcher, live, told } = harness();

    watcher.set([subject('a/one')]);
    live.get('a/one')?.({ error: 'no' });

    expect(told.size).toBe(0);
  });

  test('a row that leaves the watch drops its list', () => {
    const { watcher, live, told } = harness();

    watcher.set([subject('a/one')]);
    live.get('a/one')?.({ checks: [] });
    watcher.set([]);

    expect(told.has('github:a/one')).toBe(false);
  });

  test('stop lets go of every subject', () => {
    const { watcher, live } = harness();

    watcher.set([subject('a/one'), subject('a/two')]);
    watcher.stop();

    expect(live.size).toBe(0);
  });
});
