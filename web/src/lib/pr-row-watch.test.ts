/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { STREAM_SUBJECT_CAP } from './check-feed';
import { SHOWN_PILLS } from './linked-pull-requests';
import {
  linkedPullRequestsToWatch,
  pullRequestKey,
  pullRequestsInView,
  pullRequestsToWatch,
} from './pr-row-watch';

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

describe('pullRequestsInView', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(i + 1));
  const inView = (...numbers: number[]) =>
    new Set(numbers.map((n) => pullRequestKey(row(n))));

  test('watches the rows in view, not the first ones', () => {
    expect(
      pullRequestsInView(rows, inView(12, 13, 14, 15, 16, 17, 18)).map(
        (s) => s.number,
      ),
    ).toEqual([12, 13, 14, 15, 16, 17, 18]);
  });

  test('keeps the order the rows are drawn in', () => {
    expect(
      pullRequestsInView(rows, inView(9, 3, 6)).map((s) => s.number),
    ).toEqual([3, 6, 9]);
  });

  test('takes the first rows in view once more than the cap show', () => {
    const many = inView(...rows.map((r) => r.number));

    expect(pullRequestsInView(rows, many).map((s) => s.number)).toEqual(
      rows.slice(0, STREAM_SUBJECT_CAP - 1).map((r) => r.number),
    );
  });

  test('watches nothing when no row is in view', () => {
    expect(pullRequestsInView(rows, inView())).toEqual([]);
  });

  test('reads the first rows until the view has been reported', () => {
    expect(pullRequestsInView(rows, undefined)).toEqual(
      pullRequestsToWatch(rows),
    );
  });
});

describe('linkedPullRequestsToWatch', () => {
  const issue = (...linked: ReturnType<typeof row>[]) => ({
    linkedPullRequests: linked,
  });

  test('names the pull requests the rows link, in the order drawn', () => {
    expect(
      linkedPullRequestsToWatch([issue(row(3)), issue(row(1, 'b/two'))]),
    ).toEqual([
      { kind: 'pull_request', forge: 'github', fullName: 'a/one', number: 3 },
      { kind: 'pull_request', forge: 'github', fullName: 'b/two', number: 1 },
    ]);
  });

  test('skips the pills a row keeps behind its count', () => {
    const many = Array.from({ length: SHOWN_PILLS + 2 }, (_, i) => row(i + 1));

    expect(
      linkedPullRequestsToWatch([issue(...many)]).map((s) => s.number),
    ).toEqual(many.slice(0, SHOWN_PILLS).map((r) => r.number));
  });

  test('watches a pull request once however many issues link it', () => {
    expect(
      linkedPullRequestsToWatch([issue(row(1)), issue(row(1), row(2))]),
    ).toHaveLength(2);
  });

  test('leaves a row with no links, or an unset list, out', () => {
    expect(linkedPullRequestsToWatch([{}, issue(), issue(row(5))])).toEqual([
      { kind: 'pull_request', forge: 'github', fullName: 'a/one', number: 5 },
    ]);
  });

  test('leaves one slot of the cap for the pipeline dialog', () => {
    const rows = Array.from({ length: 20 }, (_, i) => issue(row(i + 1)));

    expect(linkedPullRequestsToWatch(rows)).toHaveLength(
      STREAM_SUBJECT_CAP - 1,
    );
  });
});

describe('pullRequestKey', () => {
  test('is the row key the board uses, from a subject or a row', () => {
    const subject = pullRequestsToWatch([row(7)])[0];

    expect(pullRequestKey(row(7))).toBe('github:a/one#7');
    expect(subject && pullRequestKey(subject)).toBe('github:a/one#7');
  });
});
