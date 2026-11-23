import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  advisoryFactsOf,
  FORGE_LABELS,
  forgeCan,
  forgeClassOf,
  forgeIds,
  forgeLabelOf,
  forgeListText,
  imagePolicyOf,
  isKnownForge,
  pullRequestUrlOf,
  rateLimitDocsUrlOf,
  rateLimitModelOf,
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
      expect(rateLimitModelOf(forge)).toBe(caps.rateLimitModel as string);
      expect(statusPageUrlOf(forge)).toBe(caps.statusPageUrl as string);
      expect(rateLimitDocsUrlOf(forge)).toBe(caps.rateLimitDocsUrl as string);
      expect(pullRequestUrlOf(forge, 'https://x.example/o/r/issues/7')).toBe(
        `https://x.example/o/r/${caps.pullRequestPathSegment as string}/7`,
      );
      expect(advisoryFactsOf(forge)).toEqual({
        source: caps.advisorySource as string,
        unknownNeedsReason: caps.advisoryUnknownNeedsReason as boolean,
      });
      const prefix = caps.signedAttachmentPrefix as string;
      expect(imagePolicyOf(forge)).toEqual({
        hosts: caps.imageHosts as string[],
        ...(prefix ? { signedAttachmentPrefix: prefix } : {}),
      });
    }
  });

  test("a registered forge brings its own image policy, replacing the seed's", () => {
    registerForgeCapabilities([
      {
        forge: 'gitea',
        capabilities: {
          imageHosts: ['cdn.gitea.test'],
          signedAttachmentPrefix: 'https://cdn.gitea.test/files/',
        },
      },
      {
        forge: 'github',
        capabilities: { imageHosts: [], signedAttachmentPrefix: '' },
      },
    ]);

    expect(imagePolicyOf('gitea')).toEqual({
      hosts: ['cdn.gitea.test'],
      signedAttachmentPrefix: 'https://cdn.gitea.test/files/',
    });
    expect(imagePolicyOf('github')).toEqual({ hosts: [] });
  });

  test('a read that names no image fields keeps the image policy it had', () => {
    registerForgeCapabilities([
      { forge: 'github', capabilities: { label: 'GitHub' } },
    ]);

    expect(imagePolicyOf('github')?.hosts).toContain('github.com');
  });

  test('a registered third forge brings its own rate limit model', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { rateLimitModel: 'graphql_and_rest' } },
    ]);

    expect(rateLimitModelOf('gitea')).toBe('graphql_and_rest');
    expect(rateLimitModelOf('never-heard-of')).toBe('');
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

describe('rateLimitDocsUrlOf', () => {
  test('a forge learns its rate limit docs from the capabilities the API sent', () => {
    registerForgeCapabilities([
      {
        forge: 'gitea',
        capabilities: { rateLimitDocsUrl: 'https://docs.example/limits' },
      },
    ]);

    expect(rateLimitDocsUrlOf('gitea')).toBe('https://docs.example/limits');
  });

  test('a forge with none, or one never heard of, has no link', () => {
    expect(rateLimitDocsUrlOf('forgejo')).toBe('');
    expect(rateLimitDocsUrlOf('nowhere')).toBe('');
  });

  test('an empty answer clears the seeded link, and reset puts it back', () => {
    registerForgeCapabilities([
      { forge: 'github', capabilities: { rateLimitDocsUrl: '' } },
    ]);
    expect(rateLimitDocsUrlOf('github')).toBe('');

    resetForgeCapabilities();

    expect(rateLimitDocsUrlOf('github')).toContain('docs.github.com');
  });
});

describe('pullRequestUrlOf', () => {
  const issue = 'https://git.example/o/r/issues/12';

  test('GitHub and Forgejo put a different segment before the number', () => {
    expect(pullRequestUrlOf('github', issue)).toBe(
      'https://git.example/o/r/pull/12',
    );
    expect(pullRequestUrlOf('forgejo', issue)).toBe(
      'https://git.example/o/r/pulls/12',
    );
  });

  test('a forge learns its segment from the capabilities the API sent', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { pullRequestPathSegment: 'merge' } },
    ]);

    expect(pullRequestUrlOf('gitea', issue)).toBe(
      'https://git.example/o/r/merge/12',
    );
  });

  test('a forge nobody described leaves the address as it was', () => {
    expect(pullRequestUrlOf('nowhere', issue)).toBe(issue);
    expect(pullRequestUrlOf(undefined, issue)).toBe(issue);
  });

  test('an address that is not an issue address is left alone', () => {
    const other = 'https://git.example/o/r/pull/12';

    expect(pullRequestUrlOf('github', other)).toBe(other);
  });

  test('reset puts the seeded segments back', () => {
    registerForgeCapabilities([
      { forge: 'github', capabilities: { pullRequestPathSegment: 'x' } },
    ]);
    resetForgeCapabilities();

    expect(pullRequestUrlOf('github', issue)).toBe(
      'https://git.example/o/r/pull/12',
    );
  });
});

describe('rateLimitModelOf', () => {
  // Kept on purpose, like the flags: a read that names the forge but not the
  // model leaves what the page already learned. The API always sends the
  // model, so this only shields a partial payload from erasing it.
  test('a re-registration without a model keeps the one already learned', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { rateLimitModel: 'graphql_and_rest' } },
    ]);
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { label: 'Gitea' } },
    ]);

    expect(rateLimitModelOf('gitea')).toBe('graphql_and_rest');
  });

  test('a re-registration with a new model replaces the old one', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { rateLimitModel: 'graphql_and_rest' } },
    ]);
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { rateLimitModel: 'rest' } },
    ]);

    expect(rateLimitModelOf('gitea')).toBe('rest');
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

const INHERITED_KEYS = [
  'constructor',
  'toString',
  '__proto__',
  'hasOwnProperty',
];

describe('forgeLabelOf and forgeClassOf', () => {
  test.each(INHERITED_KEYS)(
    'a forge named %s reads as nobody described it',
    (id) => {
      expect(forgeLabelOf(id)).toBe(id);
      expect(forgeClassOf(id)).toBe('');
    },
  );

  test('github, forgejo and a registered gitea read as before', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { label: 'Gitea' } },
    ]);

    expect(forgeLabelOf('github')).toBe('GitHub');
    expect(forgeClassOf('github')).toBe('gh');
    expect(forgeLabelOf('forgejo')).toBe('Forgejo');
    expect(forgeClassOf('forgejo')).toBe('fj');
    expect(forgeLabelOf('gitea')).toBe('Gitea');
    expect(forgeClassOf('gitea')).toBe('');
  });
});

describe('registering a forge named like an inherited key', () => {
  test.each(INHERITED_KEYS)('%s registers as a plain forge', (id) => {
    registerForgeCapabilities([
      {
        forge: id,
        capabilities: {
          label: 'Odd',
          servesRunningLog: true,
          advisorySource: 'dependabot',
        },
      },
    ]);

    expect(forgeLabelOf(id)).toBe('Odd');
    expect(forgeCan(id, 'servesRunningLog')).toBe(true);
    expect(advisoryFactsOf(id)?.source).toBe('dependabot');
    expect(Object.getPrototypeOf(FORGE_LABELS)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(advisoryFactsOf('github'))).toBe(
      Object.prototype,
    );
  });
});
