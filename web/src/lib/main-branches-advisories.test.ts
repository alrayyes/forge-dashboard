/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { registerForgeCapabilities, resetForgeCapabilities } from './forges';
import {
  ADVISORY_WORDS_BY_SOURCE,
  type Advisories,
  advisoryCounts,
  advisoryCoverage,
  advisoryCoverageByForge,
  advisoryPill,
  advisoryPillOpensDialog,
  advisoryReasonNeedsGrant,
  advisoryRowHint,
  advisoryRowUnreadable,
  advisoryUnknownReason,
  advisoryWordsFor,
  applyFilter,
  DEFAULT_FILTER,
  isFiltered,
  type MainBranch,
  NEUTRAL_ADVISORY_WORDS,
  offeredAdvisories,
} from './main-branches';

afterEach(resetForgeCapabilities);

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

describe('advisoryPill on a partly checked lock file', () => {
  const hint =
    'Some packages in the lock files are not public, so they were not checked.';

  test('a count reads as a floor and says why', () => {
    expect(
      advisoryPill({
        state: 'known',
        count: 3,
        highest: 'high',
        partial: true,
      }),
    ).toEqual({
      tone: 'high',
      text: 'At least 3 advisories, high',
      href: null,
      hint,
    });
  });

  test('one advisory is singular', () => {
    expect(
      advisoryPill({ state: 'known', count: 1, partial: true })?.text,
    ).toBe('At least 1 advisory');
  });

  test('a zero is not a clean bill: the pill says it was partly checked', () => {
    expect(advisoryPill({ state: 'known', count: 0, partial: true })).toEqual({
      tone: 'counted',
      text: 'None found, partly checked',
      href: null,
      hint,
    });
  });

  test('a whole answer carries no hint', () => {
    expect(
      advisoryPill({ state: 'known', count: 2, partial: false })?.hint,
    ).toBeUndefined();
  });

  test('a partly checked zero is neither in Has advisories nor in No advisories', () => {
    const rows = [
      b({ state: 'known', count: 0, partial: true }),
      b({ state: 'known', count: 0 }),
      b({ state: 'known', count: 2, partial: true }),
    ];
    expect(advisoryCounts(rows)).toEqual({ has: 1, none: 1, unknown: 1 });
    expect(
      applyFilter(rows, { ...DEFAULT_FILTER, advisories: 'none' }),
    ).toEqual([rows[1]]);
    expect(applyFilter(rows, { ...DEFAULT_FILTER, advisories: 'has' })).toEqual(
      [rows[2]],
    );
  });
});

const b = (advisories?: Advisories) =>
  ({ forge: 'github', advisories }) as MainBranch;
const unknown: Advisories = { state: 'unknown', count: 0 };
const known: Advisories = { state: 'known', count: 0 };

describe('advisoryCoverage', () => {
  test('every row that has an answer is unknown: one notice', () => {
    expect(advisoryCoverage([b(unknown), b(unknown), b()], 'github')).toBe(
      'none',
    );
  });

  test('some known, some unknown: a quiet cue on the unknown rows', () => {
    expect(advisoryCoverage([b(unknown), b(known)], 'github')).toBe('partial');
  });

  test('Forgejo rows without a reason never raise the GitHub notice or a cue', () => {
    const fj = (a?: Advisories) =>
      ({ forge: 'forgejo', advisories: a }) as MainBranch;
    const gh = (a?: Advisories) =>
      ({ forge: 'github', advisories: a }) as MainBranch;
    // A Forgejo repo with no lockfile is unknown, and says nothing about GitHub.
    expect(advisoryCoverage([fj(unknown), fj(unknown)], 'github')).toBe('full');
    expect(advisoryCoverage([gh(known), fj(unknown)], 'github')).toBe('full');
    expect(advisoryCoverage([gh(unknown), fj(known)], 'github')).toBe('none');
    expect(
      advisoryUnknownReason([fj(unknown), gh(unknown)], 'github'),
    ).toBeNull();
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
    expect(advisoryCoverage([fj(why('failed'))], 'github')).toBe('full');
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
    expect(advisoryCoverage([b(known), b()], 'github')).toBe('full');
    expect(advisoryCoverage([b(), b()], 'github')).toBe('full');
    expect(advisoryCoverage([], 'github')).toBe('full');
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
      advisoryUnknownReason(
        [b(why('throttled')), b(why('throttled')), b()],
        'github',
      ),
    ).toBe('throttled');
  });

  test('says nothing when the unknown rows disagree', () => {
    expect(
      advisoryUnknownReason([b(why('throttled')), b(why('refused'))], 'github'),
    ).toBeNull();
  });

  test('says nothing when any unknown row has no reason', () => {
    expect(
      advisoryUnknownReason([b(why('refused')), b(unknown)], 'github'),
    ).toBeNull();
  });

  test('ignores known rows and says nothing without unknown ones', () => {
    expect(advisoryUnknownReason([b(known), b()], 'github')).toBeNull();
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
    expect(advisoryUnknownReason([fj('failed')], 'github')).toBeNull();
  });

  test('only a refusal or switched-off alerts point at the permission steps', () => {
    expect(advisoryReasonNeedsGrant('refused')).toBe(true);
    expect(advisoryReasonNeedsGrant('switched_off')).toBe(true);
    expect(advisoryReasonNeedsGrant('throttled')).toBe(false);
    expect(ADVISORY_WORDS_BY_SOURCE.dependabot.reasons.throttled).toContain(
      'rate limiting',
    );
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

  test('has notice text only for the causes an OSV source can report', () => {
    const osv = advisoryWordsFor('forgejo').reasons;

    expect(osv.failed).toContain('OSV');
    expect(osv.too_many).toContain('more packages');
    expect(osv.refused).toBeUndefined();
  });
});

describe('advisory wording by source', () => {
  test('one table keyed by source serves each forge that names it', () => {
    registerForgeCapabilities([
      {
        forge: 'gitea',
        capabilities: {
          label: 'Gitea',
          advisorySource: 'osv',
          advisoryUnknownNeedsReason: true,
        },
      },
    ]);

    expect(advisoryWordsFor('github')).toBe(
      ADVISORY_WORDS_BY_SOURCE.dependabot,
    );
    expect(advisoryWordsFor('forgejo')).toBe(ADVISORY_WORDS_BY_SOURCE.osv);
    expect(advisoryWordsFor('gitea')).toBe(ADVISORY_WORDS_BY_SOURCE.osv);
  });

  test('a forge with no source, or one nobody wrote, is neutral, never GitHub', () => {
    registerForgeCapabilities([
      {
        forge: 'other',
        capabilities: {
          label: 'Other',
          advisorySource: 'mystery',
          advisoryUnknownNeedsReason: false,
        },
      },
    ]);

    expect(advisoryWordsFor('nowhere')).toBe(NEUTRAL_ADVISORY_WORDS);
    expect(advisoryWordsFor('other')).toBe(NEUTRAL_ADVISORY_WORDS);
    expect(NEUTRAL_ADVISORY_WORDS.fallback).not.toContain('GitHub');
    expect(NEUTRAL_ADVISORY_WORDS.grantNote).toBeNull();
  });

  test('the pill opens the dialog by what the source needs, not the forge name', () => {
    registerForgeCapabilities([
      {
        forge: 'gitea',
        capabilities: {
          label: 'Gitea',
          advisorySource: 'osv',
          advisoryUnknownNeedsReason: true,
        },
      },
    ]);

    expect(advisoryPillOpensDialog('github', { href: 'https://x.test/' })).toBe(
      true,
    );
    expect(advisoryPillOpensDialog('github', { href: null })).toBe(false);
    expect(advisoryPillOpensDialog('forgejo', { href: null })).toBe(true);
    expect(advisoryPillOpensDialog('gitea', { href: null })).toBe(true);
    expect(
      advisoryPillOpensDialog('nowhere', { href: 'https://x.test/' }),
    ).toBe(false);
  });
});

describe('a forge the page was not built with', () => {
  const row = (forge: string, reason?: string) =>
    ({
      forge,
      advisories: { state: 'unknown', count: 0, reason },
    }) as unknown as MainBranch;

  test('an undescribed forge is not read as GitHub', () => {
    const rows = [row('nowhere', 'refused')];

    expect(advisoryRowUnreadable(rows[0])).toBe(false);
    expect(advisoryCoverage(rows, 'github')).toBe('full');
    expect(advisoryUnknownReason(rows, 'github')).toBeNull();
    expect(advisoryRowHint(rows[0])).toBe('Advisories unknown');
  });

  test('a forge described as an OSV source reads like Forgejo', () => {
    registerForgeCapabilities([
      {
        forge: 'gitea',
        capabilities: {
          label: 'Gitea',
          advisorySource: 'osv',
          advisoryUnknownNeedsReason: true,
        },
      },
    ]);

    expect(advisoryRowUnreadable(row('gitea'))).toBe(false);
    expect(advisoryRowUnreadable(row('gitea', 'failed'))).toBe(true);
    expect(advisoryRowHint(row('gitea', 'failed'))).toContain('read failed');
    expect(advisoryCoverage([row('gitea', 'failed')], 'gitea')).toBe('none');
  });
});

describe('a missing forge is not read as GitHub', () => {
  const gh = {
    forge: 'github',
    advisories: { state: 'unknown', count: 0, reason: 'refused' },
  } as unknown as MainBranch;

  test('coverage and reason name no forge by default', () => {
    // Callers always say which forge; a lost argument must not become github.
    const missing = undefined as unknown as string;
    expect(advisoryCoverage([gh], missing)).toBe('full');
    expect(advisoryUnknownReason([gh], missing)).toBeNull();
  });
});

describe('advisoryCoverageByForge', () => {
  const unk = (forge: string) =>
    ({
      forge,
      advisories: { state: 'unknown', count: 0 },
    }) as unknown as MainBranch;
  const ok = (forge: string) =>
    ({
      forge,
      advisories: { state: 'known', count: 0 },
    }) as unknown as MainBranch;

  test('keys each forge the rows name, so the page never picks by name', () => {
    registerForgeCapabilities([
      {
        forge: 'gitea',
        capabilities: {
          label: 'Gitea',
          advisorySource: 'osv',
          advisoryUnknownNeedsReason: false,
        },
      },
    ]);
    const by = advisoryCoverageByForge([
      unk('github'),
      ok('github'),
      unk('gitea'),
      ok('forgejo'),
    ]);

    expect(by.github).toBe('partial');
    expect(by.gitea).toBe('none');
    expect(by.forgejo).toBe('full');
  });

  test('a forge with no advisory facts is absent, not github', () => {
    const by = advisoryCoverageByForge([unk('nowhere'), ok('github')]);

    expect(by.nowhere).toBe('full');
    expect(by.github).toBe('full');
  });
});
