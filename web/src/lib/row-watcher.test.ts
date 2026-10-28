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

    expect(log).toEqual(['stop a/one', 'watch a/three']);
  });

  test('lets go of the departed before it watches the new, so the stream never holds more than the cap', () => {
    const { watcher, live, log } = harness();
    const names = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => subject(`a/r${from + i}`));
    // The most the stream ever holds at once, counted after each call.
    let most = 0;
    const record = () => {
      most = Math.max(most, live.size);
    };

    watcher.set(names(0, 7));
    log.length = 0;
    // A page swap: every row is replaced by another.
    const before = live.size;
    watcher.set(names(7, 14));
    record();

    expect(before).toBe(7);
    expect(log.slice(0, 7).every((entry) => entry.startsWith('stop'))).toBe(
      true,
    );
    expect(log.slice(7).every((entry) => entry.startsWith('watch'))).toBe(true);
    expect(most).toBe(7);
  });

  test('never holds more subjects than the larger of the two sets', () => {
    const counts: number[] = [];
    let held = 0;
    const watcher = createRowWatcher({
      feed: {
        watch() {
          held++;
          counts.push(held);
          return () => {
            held--;
          };
        },
      },
      onChecks: () => {},
      onDrop: () => {},
    });

    watcher.set([subject('a/1'), subject('a/2'), subject('a/3')]);
    watcher.set([subject('a/3'), subject('a/4'), subject('a/5')]);

    expect(Math.max(...counts)).toBe(3);
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

  test('keys a row by the key function it is given', () => {
    const told = new Map<string, unknown>();
    const live = new Map<string, (message: CheckFeedMessage) => void>();
    const watcher = createRowWatcher({
      feed: {
        watch(s, follower) {
          live.set(String(s.number), follower);
          return () => live.delete(String(s.number));
        },
      },
      keyOf: (s) => `${s.forge}:${s.fullName}#${s.number}`,
      onChecks: (key, checks) => told.set(key, checks),
      onDrop: (key) => told.delete(key),
    });
    const pr = (number: number): Subject => ({
      kind: 'pull_request',
      forge: 'github',
      fullName: 'a/one',
      number,
    });

    watcher.set([pr(1), pr(2)]);
    live.get('2')?.({ checks: [] });

    expect(live.size).toBe(2);
    expect([...told.keys()]).toEqual(['github:a/one#2']);
  });

  test('stop lets go of every subject', () => {
    const { watcher, live } = harness();

    watcher.set([subject('a/one'), subject('a/two')]);
    watcher.stop();

    expect(live.size).toBe(0);
  });
});

describe('createRowWatcher run facts', () => {
  test('hands the run facts of a list to onChecks beside its jobs', () => {
    const told: unknown[] = [];
    let follow: (m: CheckFeedMessage) => void = () => {};
    const watcher = createRowWatcher({
      feed: {
        watch(_s, follower) {
          follow = follower;
          return () => {};
        },
      },
      onChecks: (key, checks, runs) => told.push([key, checks, runs]),
      onDrop: () => {},
    });
    const runs = [{ runId: 1, status: 'completed', conclusion: 'failure' }];

    watcher.set([subject('a/one')]);
    follow({ checks: [], runs });
    follow({ checks: [] });

    expect(told).toEqual([
      ['github:a/one', [], runs],
      ['github:a/one', [], []],
    ]);
  });
});
