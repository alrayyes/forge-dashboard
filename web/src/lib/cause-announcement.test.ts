/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { announceCauses, type CausesSeen } from './cause-announcement';

const label = (forge: string) => (forge === 'github' ? 'GitHub' : 'Forgejo');
const good = { forge: 'github', reachable: true };
const slow = { forge: 'github', reachable: true, cause: 'slow' as const };
const starting = {
  forge: 'forgejo',
  reachable: false,
  starting: true,
  cause: 'starting' as const,
};
const none: CausesSeen = new Map();

describe('announceCauses (#5024)', () => {
  test('says nothing for a first read with no cause', () => {
    expect(announceCauses(none, [good], label).text).toBeNull();
  });

  test('takes a page with no forges list as one with no cause', () => {
    expect(announceCauses(none, undefined, label).text).toBeNull();
  });

  test('names each forge that is slow or starting up', () => {
    expect(announceCauses(none, [slow], label).text).toBe(
      'GitHub slow to answer',
    );
    expect(announceCauses(none, [slow, starting], label).text).toBe(
      'GitHub slow to answer. Forgejo starting up',
    );
  });

  test('says nothing again while the causes stay the same', () => {
    const first = announceCauses(none, [slow], label);
    expect(announceCauses(first.seen, [slow], label).text).toBeNull();
  });

  test('states only the forge that gained a cause', () => {
    const first = announceCauses(none, [slow], label);
    expect(announceCauses(first.seen, [slow, starting], label).text).toBe(
      'Forgejo starting up',
    );
  });

  test('states a cause that changes', () => {
    const first = announceCauses(
      none,
      [{ ...starting, forge: 'github' }],
      label,
    );
    expect(announceCauses(first.seen, [slow], label).text).toBe(
      'GitHub slow to answer',
    );
  });

  test('empties the region when a cause goes, so the next one is heard', () => {
    const first = announceCauses(none, [slow], label);
    const cleared = announceCauses(first.seen, [good], label);
    expect(cleared.text).toBe('');
    expect(announceCauses(cleared.seen, [slow], label).text).toBe(
      'GitHub slow to answer',
    );
  });

  test('does not restate the forge still slow when another recovers', () => {
    const both = announceCauses(none, [slow, starting], label);
    const one = announceCauses(
      both.seen,
      [slow, { forge: 'forgejo', reachable: true }],
      label,
    );
    expect(one.text).toBe('');
  });
});
