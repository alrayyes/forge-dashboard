/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { failingBadge } from './failing-repo';

const at = (iso: string) => `at ${iso}`;

describe('the badge on a repo whose fetch failed', () => {
  test('a repo fetching fine has none', () => {
    expect(failingBadge({}, at)).toBeNull();
  });

  test('a repo that failed says since when', () => {
    const badge = failingBadge({ failingSince: '2026-11-24T08:00:00Z' }, at);
    expect(badge?.label).toBe('Failing since at 2026-11-24T08:00:00Z');
    expect(badge?.forGood).toBe(false);
    expect(badge?.note).toContain("can't fetch this repo");
  });

  test('a repo past the cutoff reads Still failing since', () => {
    const badge = failingBadge(
      { failingSince: '2026-11-23T08:00:00Z', failingForGood: true },
      at,
    );
    expect(badge?.label).toBe('Still failing since at 2026-11-23T08:00:00Z');
    expect(badge?.forGood).toBe(true);
    expect(badge?.note).toContain("Retrying hasn't helped");
  });

  test('the cutoff flag alone, with no time, shows nothing', () => {
    expect(failingBadge({ failingForGood: true }, at)).toBeNull();
  });
});
