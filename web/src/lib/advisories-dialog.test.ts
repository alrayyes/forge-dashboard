/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  type AdvisoryItem,
  type AdvisoryList,
  chipsOf,
  cvssBand,
  epssText,
  filterBySeverity,
  forgeWords,
  readAdvisoryList,
  referenceLinks,
  severityCounts,
  unreadableText,
} from './advisories-dialog';

const item = (over: Partial<AdvisoryItem> = {}): AdvisoryItem => ({
  number: 1,
  state: 'open',
  summary: 'A flaw',
  severity: 'high',
  ...over,
});

describe('severityCounts and filterBySeverity', () => {
  const items = [
    item({ number: 1, severity: 'critical' }),
    item({ number: 2, severity: 'high' }),
    item({ number: 3, severity: 'high' }),
    item({ number: 4, severity: 'low' }),
    item({ number: 5, severity: undefined }),
  ];

  test('counts each severity, and an advisory with none under no level', () => {
    expect(severityCounts(items)).toEqual({
      critical: 1,
      high: 2,
      medium: 0,
      low: 1,
    });
  });

  test('all keeps every row, a level keeps only its own, in order', () => {
    expect(filterBySeverity(items, 'all').map((i) => i.number)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(filterBySeverity(items, 'high').map((i) => i.number)).toEqual([
      2, 3,
    ]);
  });
});

describe('chipsOf', () => {
  test('package and ecosystem, scope, then relationship', () => {
    expect(
      chipsOf(
        item({
          package: 'certifi',
          ecosystem: 'pip',
          scope: 'runtime',
          relationship: 'direct',
        }),
      ),
    ).toEqual([
      { kind: 'package', text: 'certifi', detail: 'pip' },
      { kind: 'scope', text: 'runtime' },
      { kind: 'relationship', text: 'direct' },
    ]);
  });

  test('leaves out what GitHub did not say', () => {
    expect(chipsOf(item({ package: 'x' }))).toEqual([
      { kind: 'package', text: 'x', detail: '' },
    ]);
    expect(chipsOf(item())).toEqual([]);
  });
});

describe('referenceLinks', () => {
  test('keeps only http(s) links, each with its host', () => {
    expect(
      referenceLinks([
        'https://nvd.nist.gov/vuln/detail/CVE-1',
        'javascript:alert(1)',
        'not a url',
        'http://example.com/a',
      ]),
    ).toEqual([
      { url: 'https://nvd.nist.gov/vuln/detail/CVE-1', host: 'nvd.nist.gov' },
      { url: 'http://example.com/a', host: 'example.com' },
    ]);
  });

  test('no references is no links', () => {
    expect(referenceLinks(undefined)).toEqual([]);
  });
});

describe('cvssBand', () => {
  test('names the band the score falls in, as the CVSS spec does', () => {
    expect(cvssBand(0)).toBe('None');
    expect(cvssBand(3.9)).toBe('Low');
    expect(cvssBand(4)).toBe('Medium');
    expect(cvssBand(6.9)).toBe('Medium');
    expect(cvssBand(7)).toBe('High');
    expect(cvssBand(8.9)).toBe('High');
    expect(cvssBand(9)).toBe('Critical');
  });
});

describe('epssText', () => {
  test('a probability and its percentile, in percent', () => {
    expect(epssText({ percentage: 0.0084, percentile: 0.78 })).toBe(
      '0.84% (78th percentile)',
    );
  });

  test('says "under 0.01%" instead of 0.00%', () => {
    expect(epssText({ percentage: 0.00001, percentile: 0.01 })).toBe(
      'under 0.01% (1st percentile)',
    );
  });
});

describe('readAdvisoryList', () => {
  const ok = (body: AdvisoryList) => async () =>
    new Response(JSON.stringify(body), { status: 200 });

  test('asks for the repo on its forge and returns the list', async () => {
    let asked = '';
    const body: AdvisoryList = {
      state: 'known',
      advisories: [item()],
    };
    const result = await readAdvisoryList('github', 'acme/x', async (url) => {
      asked = String(url);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    expect(asked).toBe(
      '/api/v1/main-branches/advisories?forge=github&fullName=acme%2Fx',
    );
    expect(result).toEqual({ kind: 'ready', list: body });
  });

  test('an unknown list is still ready: the dialog says why', async () => {
    const body: AdvisoryList = {
      state: 'unknown',
      reason: 'refused',
      advisories: [],
    };
    expect(await readAdvisoryList('github', 'a/b', ok(body))).toEqual({
      kind: 'ready',
      list: body,
    });
  });

  test('a 401 means sign in again', async () => {
    const result = await readAdvisoryList(
      'github',
      'a/b',
      async () => new Response('{}', { status: 401 }),
    );
    expect(result).toEqual({ kind: 'signed-out' });
  });

  test('an error answer carries the server reason', async () => {
    const result = await readAdvisoryList(
      'github',
      'a/b',
      async () =>
        new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
        }),
    );
    expect(result).toEqual({ kind: 'error', message: 'rate limited' });
  });

  test('a dropped request is an error, not a throw', async () => {
    const result = await readAdvisoryList('github', 'a/b', async () => {
      throw new TypeError('network down');
    });
    expect(result).toEqual({ kind: 'error', message: 'network down' });
  });
});

describe('forgeWords', () => {
  test('a Forgejo list talks about OSV and lock files, not alerts', () => {
    const w = forgeWords('forgejo');
    expect(w.linkName).toBe('OSV');
    expect(w.fileLabel).toBe('Lock file');
    expect(w.dateWord).toBe('Published');
    expect(w.patchedLabel).toBe('Fixed in');
    expect(w.empty).toContain('OSV');
    expect(w.empty).not.toContain('Dependabot');
  });

  test('a GitHub list keeps the alert words', () => {
    const w = forgeWords('github');
    expect(w.linkName).toBe('GitHub');
    expect(w.foundIn).toBe('Detected in');
    expect(w.dateWord).toBe('Opened');
    expect(w.patchedLabel).toBe('Patched in');
    expect(w.empty).toContain('Dependabot');
  });
});

describe('unreadableText', () => {
  test('a Forgejo failure also names the forge not answering', () => {
    expect(unreadableText('forgejo', 'failed')).toMatch(/forge did not answer/);
  });

  test('a Forgejo cause is never the GitHub permission advice', () => {
    for (const reason of [undefined, 'not_enabled', 'failed', 'too_many']) {
      const text = unreadableText('forgejo', reason);
      expect(text).not.toMatch(/Dependabot|permission|GitHub/);
    }
  });

  test('each Forgejo cause says what happened', () => {
    expect(unreadableText('forgejo', 'not_enabled')).toContain(
      'OSV_ADVISORIES',
    );
    expect(unreadableText('forgejo', 'failed')).toContain('OSV could not');
    expect(unreadableText('forgejo', 'too_many')).toContain('more');
    expect(unreadableText('forgejo', undefined)).toContain('lock file');
  });

  test('a GitHub cause keeps the permission advice', () => {
    expect(unreadableText('github', 'refused')).toContain('Dependabot');
    expect(unreadableText('github', 'throttled')).toContain('rate limiting');
  });
});
