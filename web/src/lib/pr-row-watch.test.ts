/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { STREAM_SUBJECT_CAP } from './main-branches';
import { pullRequestKey, pullRequestsToWatch } from './pr-row-watch';

const row = (number: number, repo = 'a/one') => ({
  forge: 'github',
  repo,
  number,
});

describe('pullRequestsToWatch', () => {
  test('names each row as a pull request subject, in order', () => {
    expect(pullRequestsToWatch([row(2), row(1, 'b/two')])).toEqual([
      { kind: 'pull_request', forge: 'github', fullName: 'a/one', number: 2 },
      { kind: 'pull_request', forge: 'github', fullName: 'b/two', number: 1 },
    ]);
  });

  test('leaves one slot of the cap for the pipeline dialog', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1));

    expect(pullRequestsToWatch(rows)).toHaveLength(STREAM_SUBJECT_CAP - 1);
    expect(pullRequestsToWatch(rows)[0]?.number).toBe(1);
  });

  test('a limit above the cap cannot exceed it', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1));

    expect(pullRequestsToWatch(rows, 50)).toHaveLength(STREAM_SUBJECT_CAP - 1);
  });

  test('watches a row once however often it is listed', () => {
    expect(pullRequestsToWatch([row(1), row(1), row(2)])).toHaveLength(2);
  });
});

describe('pullRequestKey', () => {
  test('is the row key the board uses, from a subject or a row', () => {
    const subject = pullRequestsToWatch([row(7)])[0];

    expect(pullRequestKey(row(7))).toBe('github:a/one#7');
    expect(subject && pullRequestKey(subject)).toBe('github:a/one#7');
  });
});
