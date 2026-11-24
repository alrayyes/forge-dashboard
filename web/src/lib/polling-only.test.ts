import { describe, expect, test } from 'bun:test';
import {
  isPollingOnly,
  pollingFilterHolds,
  pollingOnlyCount,
  pollingOnlyKeys,
  pollingOnlyNotice,
  pollingOnlyReason,
} from './polling-only';

const repo = (over = {}) => ({
  forge: 'github',
  fullName: 'o/a',
  ignored: false,
  hasWebhook: false,
  canManageWebhooks: true,
  ...over,
});

describe('isPollingOnly', () => {
  test('a tracked repo without a hook polls', () => {
    expect(isPollingOnly(repo())).toBe(true);
  });
  test('a repo with a hook does not', () => {
    expect(isPollingOnly(repo({ hasWebhook: true }))).toBe(false);
  });
  test('an ignored repo is not counted', () => {
    expect(isPollingOnly(repo({ ignored: true }))).toBe(false);
  });
});

describe('pollingOnlyCount and keys', () => {
  const rows = [
    repo(),
    repo({ fullName: 'o/b', hasWebhook: true }),
    repo({ fullName: 'o/c' }),
    repo({ fullName: 'o/d', ignored: true }),
  ];
  test('counts the polling rows', () => {
    expect(pollingOnlyCount(rows)).toBe(2);
  });
  test('keys are forge:fullName', () => {
    expect(
      [...pollingOnlyKeys(rows)].sort((a, b) => a.localeCompare(b)),
    ).toEqual(['github:o/a', 'github:o/c']);
  });
});

describe('pollingOnlyNotice', () => {
  test('says nothing at zero', () => {
    expect(pollingOnlyNotice(0)).toBe('');
  });
  test('singular', () => {
    expect(pollingOnlyNotice(1)).toBe(
      '1 repo refreshes on a schedule instead of instantly',
    );
  });
  test('plural', () => {
    expect(pollingOnlyNotice(3)).toBe(
      '3 repos refresh on a schedule instead of instantly',
    );
  });
});

describe('pollingOnlyReason', () => {
  test('a token that cannot manage hooks points at Connections', () => {
    expect(pollingOnlyReason(repo({ canManageWebhooks: false }), '')).toEqual({
      line: 'Polling only: your token cannot manage webhooks here.',
      link: { text: 'Fix in Connections', href: '/settings.html#connections' },
    });
  });
  test('an origin the forge cannot reach points at the guide', () => {
    const r = pollingOnlyReason(repo(), 'the address is private');
    expect(r.line).toBe('Polling only: the forge cannot reach this dashboard.');
    expect(r.link.text).toBe('See the guide');
    expect(r.link.href).toContain('docs/webhooks.md#polling-only');
  });
  test('a forge that refused says when it tries again', () => {
    const r = pollingOnlyReason(
      repo({ webhookReason: 'forge_unavailable' }),
      '',
    );
    expect(r.line).toBe(
      "Polling only: The forge didn't answer. The dashboard will try again.",
    );
  });
  test('anything else falls back to the guide', () => {
    const r = pollingOnlyReason(repo(), '');
    expect(r.line).toBe(
      'Polling only: no webhook is set up for this repo yet.',
    );
    expect(r.link.text).toBe('See the guide');
  });
});

describe('pollingFilterHolds', () => {
  test('stays on while a repo still polls', () => {
    expect(pollingFilterHolds(true, 2)).toBe(true);
  });
  test('lets go when the last polling repo is gone, so no empty list is left', () => {
    expect(pollingFilterHolds(true, 0)).toBe(false);
  });
  test('is off when the pill was never pressed', () => {
    expect(pollingFilterHolds(false, 3)).toBe(false);
  });
});
