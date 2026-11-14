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
});
