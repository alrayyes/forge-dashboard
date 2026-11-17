import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  advisoryFactsOf,
  FORGE_LABELS,
  forgeCan,
  forgeIds,
  forgeListText,
  isKnownForge,
  registerForgeCapabilities,
  resetForgeCapabilities,
  statusPageUrlOf,
} from './forges';

afterEach(resetForgeCapabilities);

describe('registerForgeCapabilities', () => {
  test('a forge entry teaches its label from the capabilities the API sent', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { label: 'Gitea' } },
    ]);

    expect(FORGE_LABELS.gitea).toBe('Gitea');
  });

  test('an entry with no capabilities, or none at all, changes nothing', () => {
    registerForgeCapabilities([{ forge: 'plain' }]);
    registerForgeCapabilities(undefined);

    expect(FORGE_LABELS.plain).toBeUndefined();
  });

  test('the shipped forges are named before any read, and capabilities override', () => {
    expect(FORGE_LABELS.github).toBe('GitHub');
    expect(FORGE_LABELS.forgejo).toBe('Forgejo');

    try {
      registerForgeCapabilities([
        { forge: 'forgejo', capabilities: { label: 'Codeberg' } },
      ]);
      expect(FORGE_LABELS.forgejo).toBe('Codeberg');
    } finally {
      // Put the seed back even when the assertion fails, so a failure here
      // doesn't leak a label into later tests in the same process.
      registerForgeCapabilities([
        { forge: 'forgejo', capabilities: { label: 'Forgejo' } },
      ]);
    }
  });
});

describe('advisoryFactsOf', () => {
  test('the shipped forges answer before any read', () => {
    expect(advisoryFactsOf('github')).toEqual({
      source: 'dependabot',
      unknownNeedsReason: false,
    });
    expect(advisoryFactsOf('forgejo')).toEqual({
      source: 'osv',
      unknownNeedsReason: true,
    });
  });

  test('a forge learns its advisory facts from the capabilities the API sent', () => {
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

    expect(advisoryFactsOf('gitea')).toEqual({
      source: 'osv',
      unknownNeedsReason: true,
    });
  });

  test('a forge nobody described has no facts, so no default is guessed', () => {
    expect(advisoryFactsOf('nowhere')).toBeUndefined();
  });
});
describe('forgeCan', () => {
  test('the shipped forges answer as the generated Go table does', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../../../tests/generated/forge-capabilities.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { forges: Record<string, Record<string, unknown>> };

    for (const [forge, caps] of Object.entries(fixture.forges)) {
      for (const flag of [
        'servesRunningLog',
        'serverLogExcerpts',
        'approvalGatedRuns',
        'autoMergeHeldByApp',
        'reportsRepoPermissions',
      ] as const) {
        expect(forgeCan(forge, flag)).toBe(caps[flag] as boolean);
      }
      expect(FORGE_LABELS[forge]).toBe(caps.label as string);
      expect(statusPageUrlOf(forge)).toBe(caps.statusPageUrl as string);
      expect(advisoryFactsOf(forge)).toEqual({
        source: caps.advisorySource as string,
        unknownNeedsReason: caps.advisoryUnknownNeedsReason as boolean,
      });
    }
  });

  test('a forge the page has not heard of can do nothing', () => {
    expect(forgeCan('unknown', 'servesRunningLog')).toBe(false);
    expect(forgeCan(undefined, 'servesRunningLog')).toBe(false);
  });

  test('a registered third forge says whether it reports repo permissions', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { reportsRepoPermissions: true } },
      { forge: 'other', capabilities: { reportsRepoPermissions: false } },
    ]);

    expect(forgeCan('gitea', 'reportsRepoPermissions')).toBe(true);
    expect(forgeCan('other', 'reportsRepoPermissions')).toBe(false);
    expect(forgeCan('never-heard-of', 'reportsRepoPermissions')).toBe(false);
  });

  test('a read teaches the flags a forge sent', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { servesRunningLog: true } },
    ]);

    expect(forgeCan('gitea', 'servesRunningLog')).toBe(true);
    expect(forgeCan('gitea', 'serverLogExcerpts')).toBe(false);
  });
});

describe('statusPageUrlOf', () => {
  test('a forge learns its status page from the capabilities the API sent', () => {
    registerForgeCapabilities([
      {
        forge: 'gitea',
        capabilities: {
          label: 'Gitea',
          statusPageUrl: 'https://status.example/',
        },
      },
    ]);

    expect(statusPageUrlOf('gitea')).toBe('https://status.example/');
  });

  test('a forge with none, or one never heard of, has no link', () => {
    expect(statusPageUrlOf('forgejo')).toBe('');
    expect(statusPageUrlOf('nowhere')).toBe('');
  });

  test('reset puts the seeded pages back', () => {
    registerForgeCapabilities([
      { forge: 'github', capabilities: { statusPageUrl: '' } },
    ]);
    resetForgeCapabilities();

    expect(statusPageUrlOf('github')).toBe('https://www.githubstatus.com/');
  });
});

describe('resetForgeCapabilities', () => {
  test('forgets what reads taught and restores the seed', () => {
    registerForgeCapabilities([
      {
        forge: 'gitea',
        capabilities: {
          label: 'Gitea',
          servesRunningLog: true,
          advisorySource: 'osv',
        },
      },
      {
        forge: 'forgejo',
        capabilities: {
          label: 'Codeberg',
          servesRunningLog: false,
          advisorySource: 'other',
        },
      },
    ]);

    resetForgeCapabilities();

    expect(forgeCan('gitea', 'servesRunningLog')).toBe(false);
    expect(FORGE_LABELS.gitea).toBeUndefined();
    expect(advisoryFactsOf('gitea')).toBeUndefined();
    expect(forgeCan('forgejo', 'servesRunningLog')).toBe(true);
    expect(FORGE_LABELS.forgejo).toBe('Forgejo');
    expect(advisoryFactsOf('forgejo')?.source).toBe('osv');
  });
});

describe('the known forges', () => {
  test('the shipped forges are known before any read', () => {
    expect(forgeIds()).toEqual(['github', 'forgejo']);
    expect(isKnownForge('github')).toBe(true);
    expect(isKnownForge('gitlab')).toBe(false);
  });

  test('a forge the server reports joins the list once, after the shipped ones', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { label: 'Gitea' } },
      { forge: 'github' },
      { forge: 'gitea' },
    ]);

    expect(forgeIds()).toEqual(['github', 'forgejo', 'gitea']);
    expect(isKnownForge('gitea')).toBe(true);
  });

  test('a forge id is matched exactly, case included', () => {
    expect(isKnownForge('GitHub')).toBe(false);
    expect(isKnownForge('github ')).toBe(false);
  });

  test('the list handed out is a copy', () => {
    forgeIds().push('gitlab');

    expect(forgeIds()).toEqual(['github', 'forgejo']);
    expect(isKnownForge('gitlab')).toBe(false);
  });

  test('reset forgets a taught forge', () => {
    registerForgeCapabilities([{ forge: 'gitea' }]);
    resetForgeCapabilities();

    expect(isKnownForge('gitea')).toBe(false);
  });

  test('the list reads as prose, quoted', () => {
    expect(forgeListText()).toBe('"github" or "forgejo"');
    registerForgeCapabilities([{ forge: 'gitea' }]);
    expect(forgeListText()).toBe('"github", "forgejo" or "gitea"');
  });
});
