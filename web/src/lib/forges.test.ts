import { describe, expect, test } from 'bun:test';
import { FORGE_LABELS, registerForgeCapabilities } from './forges';

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
