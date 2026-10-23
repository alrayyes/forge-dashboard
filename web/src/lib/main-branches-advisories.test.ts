/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  ADVISORY_REASON_TEXT,
  type Advisories,
  advisoryCounts,
  advisoryCoverage,
  advisoryPill,
  advisoryReasonNeedsGrant,
  advisoryRowHint,
  advisoryRowUnreadable,
  advisoryUnknownReason,
  applyFilter,
  DEFAULT_FILTER,
  forgejoAdvisoryReasonText,
  isFiltered,
  type MainBranch,
  offeredAdvisories,
} from './main-branches';

const URL = 'https://example.com/acme/x/security/dependabot';

describe('advisoryPill', () => {
  test('no field draws no pill', () => {
    expect(advisoryPill(undefined)).toBeNull();
  });

  test('a known zero draws no pill, so nothing alarms', () => {
    expect(advisoryPill({ state: 'known', count: 0 })).toBeNull();
  });

  test('unknown draws no pill: the page says it once instead', () => {
    expect(advisoryPill({ state: 'unknown', count: 0 })).toBeNull();
  });

  test('a count and severity read as words, linking to the url', () => {
    expect(
      advisoryPill({ state: 'known', count: 3, highest: 'high', url: URL }),
    ).toEqual({
      tone: 'high',
      text: '3 advisories, high',
      href: URL,
    });
  });

  test('one advisory is singular', () => {
    expect(
      advisoryPill({ state: 'known', count: 1, highest: 'low', url: URL })
        ?.text,
    ).toBe('1 advisory, low');
  });

  test('a missing severity still shows the count', () => {
    const pill = advisoryPill({ state: 'known', count: 2, url: URL });
    expect(pill?.text).toBe('2 advisories');
    expect(pill?.tone).toBe('counted');
  });

  test('a url that is not http(s) is not linked', () => {
    expect(
      advisoryPill({
        state: 'known',
        count: 2,
        highest: 'critical',
        url: 'javascript:alert(1)',
      })?.href,
    ).toBeNull();
  });

  test('a known count with no url shows the count, unlinked', () => {
    expect(advisoryPill({ state: 'known', count: 2, highest: 'low' })).toEqual({
      tone: 'low',
      text: '2 advisories, low',
      href: null,
    });
  });

  test('a url that does not parse is not linked', () => {
    expect(
      advisoryPill({ state: 'known', count: 1, highest: 'low', url: 'nope' })
        ?.href,
    ).toBeNull();
  });

  test('a negative count draws no pill', () => {
    expect(advisoryPill({ state: 'known', count: -1 })).toBeNull();
  });

  test('unknown draws no pill, whatever count, severity and url it carries', () => {
    expect(
      advisoryPill({
        state: 'unknown',
        count: 5,
        highest: 'critical',
        url: URL,
      }),
    ).toBeNull();
  });
});

const b = (advisories?: Advisories) => ({ advisories }) as MainBranch;
const unknown: Advisories = { state: 'unknown', count: 0 };
const known: Advisories = { state: 'known', count: 0 };

describe('advisoryCoverage', () => {
  test('every row that has an answer is unknown: one notice', () => {
    expect(advisoryCoverage([b(unknown), b(unknown), b()])).toBe('none');
  });

  test('some known, some unknown: a quiet cue on the unknown rows', () => {
    expect(advisoryCoverage([b(unknown), b(known)])).toBe('partial');
  });

  test('Forgejo rows without a reason never raise the GitHub notice or a cue', () => {
    const fj = (a?: Advisories) =>
      ({ forge: 'forgejo', advisories: a }) as MainBranch;
    const gh = (a?: Advisories) =>
      ({ forge: 'github', advisories: a }) as MainBranch;
    // A Forgejo repo with no lockfile is unknown, and says nothing about GitHub.
    expect(advisoryCoverage([fj(unknown), fj(unknown)])).toBe('full');
    expect(advisoryCoverage([gh(known), fj(unknown)])).toBe('full');
    expect(advisoryCoverage([gh(unknown), fj(known)])).toBe('none');
    expect(advisoryUnknownReason([fj(unknown), gh(unknown)])).toBeNull();
  });

  test('a Forgejo row unknown for a reason counts, one with none or not_enabled does not', () => {
    const fj = (a?: Advisories) =>
      ({ forge: 'forgejo', advisories: a }) as MainBranch;
    const why = (reason: Advisories['reason']): Advisories => ({
      ...unknown,
      reason,
    });
    expect(
      advisoryCoverage([fj(why('failed')), fj(why('failed'))], 'forgejo'),
    ).toBe('none');
    expect(advisoryCoverage([fj(why('too_many')), fj(known)], 'forgejo')).toBe(
      'partial',
    );
    // No lock file (no reason) and advisories off (not_enabled) say nothing.
    expect(
      advisoryCoverage([fj(unknown), fj(why('not_enabled'))], 'forgejo'),
    ).toBe('full');
    expect(advisoryCoverage([fj(why('failed')), fj(unknown)], 'forgejo')).toBe(
      'none',
    );
    // The GitHub cue is not about Forgejo rows, and the other way round.
    expect(advisoryCoverage([fj(why('failed'))])).toBe('full');
    expect(advisoryCoverage([b(why('failed')), b(known)], 'forgejo')).toBe(
      'full',
    );
  });

  test('a row is unreadable when unknown for a reason a user can act on or wait out', () => {
    const fj = (a?: Advisories) =>
      ({ forge: 'forgejo', advisories: a }) as MainBranch;
    expect(advisoryRowUnreadable(fj({ ...unknown, reason: 'failed' }))).toBe(
      true,
    );
    expect(advisoryRowUnreadable(fj(unknown))).toBe(false);
    expect(
      advisoryRowUnreadable(fj({ ...unknown, reason: 'not_enabled' })),
    ).toBe(false);
    expect(advisoryRowUnreadable(fj(known))).toBe(false);
    expect(advisoryRowUnreadable(b(unknown))).toBe(true);
  });

  test('all known, or no source at all, has nothing to say', () => {
    expect(advisoryCoverage([b(known), b()])).toBe('full');
    expect(advisoryCoverage([b(), b()])).toBe('full');
    expect(advisoryCoverage([])).toBe('full');
  });
});

describe('advisoryUnknownReason', () => {
  const why = (reason: Advisories['reason']): Advisories => ({
    state: 'unknown',
    count: 0,
    reason,
  });

  test('names the cause every unknown row shares', () => {
    expect(
      advisoryUnknownReason([b(why('throttled')), b(why('throttled')), b()]),
    ).toBe('throttled');
  });

  test('says nothing when the unknown rows disagree', () => {
    expect(
      advisoryUnknownReason([b(why('throttled')), b(why('refused'))]),
    ).toBeNull();
  });

  test('says nothing when any unknown row has no reason', () => {
    expect(advisoryUnknownReason([b(why('refused')), b(unknown)])).toBeNull();
  });

  test('ignores known rows and says nothing without unknown ones', () => {
    expect(advisoryUnknownReason([b(known), b()])).toBeNull();
  });

  test('names the one cause Forgejo rows share, for the Forgejo notice only', () => {
    const fj = (reason?: Advisories['reason']) =>
      ({
        forge: 'forgejo',
        advisories: { ...unknown, reason },
      }) as MainBranch;
    expect(
      advisoryUnknownReason([fj('failed'), fj('failed'), fj()], 'forgejo'),
    ).toBe('failed');
    expect(
      advisoryUnknownReason([fj('failed'), fj('too_many')], 'forgejo'),
    ).toBeNull();
    expect(advisoryUnknownReason([fj('failed')])).toBeNull();
  });

  test('only a refusal or switched-off alerts point at the permission steps', () => {
    expect(advisoryReasonNeedsGrant('refused')).toBe(true);
    expect(advisoryReasonNeedsGrant('switched_off')).toBe(true);
    expect(advisoryReasonNeedsGrant('throttled')).toBe(false);
    expect(ADVISORY_REASON_TEXT.throttled).toContain('rate limiting');
  });
});

describe('the advisories filter', () => {
  const rows = [
    { ...b({ state: 'known', count: 2, highest: 'high' }), fullName: 'a' },
    { ...b({ state: 'known', count: 0 }), fullName: 'b' },
    { ...b({ state: 'unknown', count: 0 }), fullName: 'c' },
    { ...b(undefined), fullName: 'd' },
  ] as MainBranch[];
  const names = (f: 'all' | 'has' | 'none') =>
    applyFilter(rows, { ...DEFAULT_FILTER, advisories: f }).map(
      (r) => r.fullName,
    );

  test('any keeps every row', () => {
    expect(names('all')).toEqual(['a', 'b', 'c', 'd']);
  });

  test('has keeps only a known count above zero', () => {
    expect(names('has')).toEqual(['a']);
  });

  test('no keeps only a known zero: unknown and absent are neither', () => {
    expect(names('none')).toEqual(['b']);
  });

  test('the counts say how many rows are left out as unknown', () => {
    expect(advisoryCounts(rows)).toEqual({ has: 1, none: 1, unknown: 2 });
  });

  test('a choice is a filter, so reset is offered', () => {
    expect(isFiltered(DEFAULT_FILTER)).toBe(false);
    expect(isFiltered({ ...DEFAULT_FILTER, advisories: 'has' })).toBe(true);
  });

  test('a choice is offered only when a row would show under it, and the active one stays', () => {
    const onlyClean = [rows[1]] as MainBranch[];
    expect([...offeredAdvisories(onlyClean, DEFAULT_FILTER)].sort()).toEqual([
      'all',
      'none',
    ]);
    expect(
      [
        ...offeredAdvisories(onlyClean, {
          ...DEFAULT_FILTER,
          advisories: 'has',
        }),
      ].sort(),
    ).toEqual(['all', 'has', 'none']);
  });

  test('the other filters narrow what is offered', () => {
    const mixed = [
      { ...rows[0], status: 'failed' },
      { ...rows[1], status: 'passed' },
    ] as MainBranch[];
    expect([
      ...offeredAdvisories(mixed, { ...DEFAULT_FILTER, status: 'passed' }),
    ]).not.toContain('has');
  });
});

describe('Forgejo cue wording', () => {
  const fj = (reason?: string) =>
    ({
      forge: 'forgejo',
      advisories: { state: 'unknown', count: 0, reason },
    }) as unknown as MainBranch;

  test('hints at the cause on a Forgejo row and keeps the plain label elsewhere', () => {
    expect(advisoryRowHint(fj('failed'))).toContain('read failed');
    expect(advisoryRowHint(fj('too_many'))).toContain('too much');
    expect(advisoryRowHint(fj())).toBe('Advisories unknown');
    expect(
      advisoryRowHint({
        forge: 'github',
        advisories: { state: 'unknown', count: 0, reason: 'failed' },
      } as unknown as MainBranch),
    ).toBe('Advisories unknown');
  });

  test('has notice text only for the causes Forgejo can report', () => {
    expect(forgejoAdvisoryReasonText('failed')).toContain('OSV');
    expect(forgejoAdvisoryReasonText('too_many')).toContain('more packages');
    expect(forgejoAdvisoryReasonText('refused')).toBeNull();
    expect(forgejoAdvisoryReasonText(null)).toBeNull();
  });
});
