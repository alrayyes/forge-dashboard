import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  advisoryFactsOf,
  FORGE_LABELS,
  forgeCan,
  registerForgeCapabilities,
  resetForgeCapabilities,
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
      ] as const) {
        expect(forgeCan(forge, flag)).toBe(caps[flag] as boolean);
      }
      expect(FORGE_LABELS[forge]).toBe(caps.label as string);
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

  test('a read teaches the flags a forge sent', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { servesRunningLog: true } },
    ]);

    expect(forgeCan('gitea', 'servesRunningLog')).toBe(true);
    expect(forgeCan('gitea', 'serverLogExcerpts')).toBe(false);
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
