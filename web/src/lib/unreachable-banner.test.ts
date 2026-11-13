/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { bannerCopy, type DownForge } from './unreachable-banner';

const fmt = {
  time: (iso: string) => `T(${iso})`,
  ago: (iso: string) => `A(${iso})`,
};
const gh: DownForge = {
  forge: 'github',
  label: 'GitHub',
  errorKind: 'unreachable',
  staleSince: '2026-01-01T06:28:00Z',
};
const fj: DownForge = {
  forge: 'forgejo',
  label: 'Forgejo',
  errorKind: 'unreachable',
  staleSince: '2026-01-01T07:00:00Z',
};

describe('bannerCopy', () => {
  test('one forge: named once, age, retrying once, status link for GitHub', () => {
    const c = bannerCopy([gh], fmt);
    expect(c.headline).toBe('GitHub is unreachable.');
    expect(c.detail).toBe(
      'Showing data from T(2026-01-01T06:28:00Z), A(2026-01-01T06:28:00Z). Retrying automatically.',
    );
    expect(c.statusLink).toBe(true);
  });

  test('Forgejo alone has no status link', () => {
    expect(bannerCopy([fj], fmt).statusLink).toBe(false);
  });

  test('both: one sentence naming both, the oldest data, one status link', () => {
    const c = bannerCopy([fj, gh], fmt);
    expect(c.headline).toBe('GitHub and Forgejo are unreachable.');
    expect(c.detail).toBe(
      'Showing data from T(2026-01-01T06:28:00Z), A(2026-01-01T06:28:00Z). Retrying automatically.',
    );
    expect(c.statusLink).toBe(true);
  });

  test('no staleSince: no age sentence', () => {
    const c = bannerCopy([{ ...gh, staleSince: undefined }], fmt);
    expect(c.detail).toBe('Retrying automatically.');
  });

  test('a start-up gap says starting up and still retries', () => {
    const c = bannerCopy([{ ...gh, startupGap: true }], fmt);
    expect(c.headline).toBe('GitHub is starting up.');
    expect(c.detail).toContain('Retrying automatically.');
  });

  test('an upstream error leads with what the forge answered', () => {
    const c = bannerCopy(
      [
        {
          ...gh,
          errorKind: 'upstream_error',
          upstreamError: 'GitHub answered 503',
        },
      ],
      fmt,
    );
    expect(c.headline).toBe('GitHub answered 503.');
    expect(c.detail).toContain('Retrying automatically.');
  });

  test('a bad token is not retried automatically', () => {
    const c = bannerCopy([{ ...gh, errorKind: 'unauthorized' }], fmt);
    expect(c.detail).toContain('Check the token in Settings.');
    expect(c.detail).not.toContain('Retrying');
  });

  test('a bad instance URL says so, and the retry sentence is not repeated', () => {
    const c = bannerCopy([{ ...fj, errorKind: 'not_found' }, gh], fmt);
    expect(c.detail).toContain('Check the instance URL in Settings.');
    expect(c.detail.match(/Retrying automatically/g)?.length).toBe(1);
  });

  describe('incident reported by the forge status page (#3633)', () => {
    const status = {
      indicator: 'minor',
      incidents: ['Degraded performance'],
      components: ['Pull Requests'],
    };

    test('names the incident and what it affects, as a second sentence', () => {
      const c = bannerCopy([{ ...gh, providerStatus: status }], fmt);
      expect(c.incident).toBe(
        'GitHub reports an incident: Degraded performance. Affects: Pull Requests.',
      );
      // The first line is untouched.
      expect(c.headline).toBe('GitHub is unreachable.');
    });

    test('several incidents and components are all listed', () => {
      const c = bannerCopy(
        [
          {
            ...gh,
            providerStatus: {
              indicator: 'major',
              incidents: ['Slow Actions', 'Webhook delays'],
              components: ['Actions', 'Webhooks'],
            },
          },
        ],
        fmt,
      );
      expect(c.incident).toBe(
        'GitHub reports an incident: Slow Actions; Webhook delays. Affects: Actions, Webhooks.',
      );
    });

    test('a degraded component with no incident title still says so', () => {
      const c = bannerCopy(
        [
          {
            ...gh,
            providerStatus: { indicator: 'minor', components: ['Actions'] },
          },
        ],
        fmt,
      );
      expect(c.incident).toBe('GitHub reports trouble with: Actions.');
    });

    test('nothing reported, nothing added', () => {
      expect(bannerCopy([gh], fmt).incident).toBeUndefined();
      expect(
        bannerCopy([{ ...gh, providerStatus: { indicator: 'none' } }], fmt)
          .incident,
      ).toBeUndefined();
    });

    test('with both forges down it is still GitHub that reports', () => {
      const c = bannerCopy([fj, { ...gh, providerStatus: status }], fmt);
      expect(c.incident).toBe(
        'GitHub reports an incident: Degraded performance. Affects: Pull Requests.',
      );
    });

    test('a starting-up forge is not blamed on GitHub', () => {
      const c = bannerCopy(
        [{ ...gh, startupGap: true, providerStatus: status }],
        fmt,
      );
      expect(c.incident).toBeUndefined();
    });
  });
});
