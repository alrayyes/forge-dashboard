import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GROUP,
  groupFromHash,
  SETTINGS_GROUPS,
} from './settings-groups.js';

describe('settings groups', () => {
  test('four groups in the agreed order', () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual([
      'Display',
      'Connections',
      'Behaviour',
      'Integrations and security',
    ]);
  });

  test('no hash and unknown hashes open Display', () => {
    expect(groupFromHash('')).toEqual({ group: DEFAULT_GROUP });
    expect(groupFromHash('#')).toEqual({ group: 'display' });
    expect(groupFromHash('#nonsense')).toEqual({ group: 'display' });
  });

  test('a group id opens that group and scrolls nowhere', () => {
    for (const g of SETTINGS_GROUPS) {
      expect(groupFromHash(`#${g.id}`)).toEqual({ group: g.id });
    }
  });

  test('an existing card anchor opens its group and names the card', () => {
    expect(groupFromHash('#issue-settings')).toEqual({
      group: 'behaviour',
      anchor: 'issue-settings',
    });
    expect(groupFromHash('#forgejo-auto-merge')).toEqual({
      group: 'behaviour',
      anchor: 'forgejo-auto-merge',
    });
    for (const id of ['webhooks', 'passkeys', 'api-tokens']) {
      expect(groupFromHash(`#${id}`)).toEqual({
        group: 'integrations',
        anchor: id,
      });
    }
    expect(groupFromHash('#github-token').group).toBe('connections');
  });
});
