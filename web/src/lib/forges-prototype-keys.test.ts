import { afterEach, describe, expect, test } from 'bun:test';
import { forgeWords, unreadableText } from './advisories-dialog';
import { approveLinkCopy } from './forge-copy';
import {
  advisoryFactsOf,
  forgeCan,
  forgeClassOf,
  forgeFlag,
  forgeLabelOf,
  imagePolicyOf,
  rateLimitDocsUrlOf,
  rateLimitModelOf,
  registerForgeCapabilities,
  registerImagePolicy,
  resetForgeCapabilities,
  statusPageUrlOf,
} from './forges';
import { advisoryWordsFor, NEUTRAL_ADVISORY_WORDS } from './main-branches';

// A forge id is data from the server. One named like an Object.prototype key
// must read as a forge nobody described, never as an inherited member.
const PROTOTYPE_KEYS = [
  'constructor',
  'toString',
  '__proto__',
  'hasOwnProperty',
];

describe.each(PROTOTYPE_KEYS)('a forge named %s', (forge) => {
  test('has no advisory facts, rate limit model or status page', () => {
    expect(advisoryFactsOf(forge)).toBeUndefined();
    expect(rateLimitModelOf(forge)).toBe('');
    expect(statusPageUrlOf(forge)).toBe('');
    expect(rateLimitDocsUrlOf(forge)).toBe('');
  });

  test('has no flags', () => {
    expect(forgeCan(forge, 'reportsRepoPermissions')).toBe(false);
    expect(forgeFlag(forge, 'reportsRepoPermissions')).toBeUndefined();
  });

  test('is labelled by its own name', () => {
    expect(forgeLabelOf(forge)).toBe(forge);
    expect(approveLinkCopy(forge).text).toBe(`Approve on ${forge}`);
  });

  test('has no badge class', () => {
    expect(forgeClassOf(forge)).toBe('');
  });

  test('gets neutral advisory words', () => {
    expect(advisoryWordsFor(forge)).toBe(NEUTRAL_ADVISORY_WORDS);
    expect(forgeWords(forge).linkName).toBe('the advisory');
    expect(unreadableText(forge, 'failed')).toBe(
      'The forge did not answer the read.',
    );
  });
});

describe.each(PROTOTYPE_KEYS)('an unreadable reason named %s', (reason) => {
  test('falls back to the plain sentence of its source', () => {
    expect(unreadableText('forgejo', reason)).toMatch(/no lock file/);
    expect(unreadableText('github', reason)).toBe(
      'GitHub did not answer the read.',
    );
  });
});

describe.each(PROTOTYPE_KEYS)('an advisory source named %s', (source) => {
  afterEach(resetForgeCapabilities);

  test('gets neutral words, not an inherited member', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { advisorySource: source } },
    ]);

    expect(advisoryWordsFor('gitea')).toBe(NEUTRAL_ADVISORY_WORDS);
    expect(forgeWords('gitea').linkName).toBe('the advisory');
  });
});

// A forge the server describes under a prototype key is stored as an own
// entry. A plain `registry[key] = value` would reassign the registry's
// prototype for `__proto__` and drop the entry for the others.
describe.each(PROTOTYPE_KEYS)('registering a forge named %s', (forge) => {
  afterEach(resetForgeCapabilities);

  test('keeps what it taught, under its own key', () => {
    registerForgeCapabilities([
      {
        forge,
        capabilities: {
          label: 'Odd',
          statusPageUrl: 'https://status.example/',
          rateLimitModel: 'budget',
          rateLimitDocsUrl: 'https://docs.example/',
          advisorySource: 'osv',
          reportsRepoPermissions: true,
        },
      },
    ]);
    registerImagePolicy(forge, { hosts: ['img.example'] });

    expect(forgeLabelOf(forge)).toBe('Odd');
    expect(statusPageUrlOf(forge)).toBe('https://status.example/');
    expect(rateLimitModelOf(forge)).toBe('budget');
    expect(rateLimitDocsUrlOf(forge)).toBe('https://docs.example/');
    expect(advisoryFactsOf(forge)?.source).toBe('osv');
    expect(forgeCan(forge, 'reportsRepoPermissions')).toBe(true);
    expect(imagePolicyOf(forge)).toEqual({ hosts: ['img.example'] });
  });

  test('leaves other forges and the prototype alone', () => {
    registerForgeCapabilities([{ forge, capabilities: { label: 'Odd' } }]);

    expect(forgeLabelOf('github')).toBe('GitHub');
    expect(forgeLabelOf('somethingelse')).toBe('somethingelse');
    expect(({} as Record<string, unknown>).label).toBeUndefined();
    expect(forgeLabelOf('label')).toBe('label');
  });
});
