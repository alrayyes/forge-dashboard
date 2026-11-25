import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GROUP,
  groupFromHash,
  SETTINGS_GROUPS,
} from './settings-groups.js';

describe('settings groups', () => {
  test('a card id for any forge holding auto-merge opens Behaviour', () => {
    expect(groupFromHash('#gitea-auto-merge')).toEqual({
      group: 'behaviour',
      anchor: 'gitea-auto-merge',
    });
  });

  test('five groups in the agreed order, Repositories last', () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual([
      'Display',
      'Connections',
      'Behaviour',
      'Integrations and security',
      'Repositories',
    ]);
  });

  test('Repositories opens from its own hash, with its caption', () => {
    expect(groupFromHash('#repositories')).toEqual({ group: 'repositories' });
    const repositories = SETTINGS_GROUPS.find((g) => g.id === 'repositories');
    expect(repositories?.caption()).toBe('Auto-update, rebase bots, ignore');
  });

  test('Integrations no longer names Webhooks in its caption', () => {
    const integrations = SETTINGS_GROUPS.find((g) => g.id === 'integrations');
    expect(integrations?.caption()).not.toMatch(/webhook/i);
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

  test('the removed Webhooks card anchors open Integrations and name no card', () => {
    for (const id of ['webhooks', 'webhook-howto']) {
      expect(groupFromHash(`#${id}`)).toEqual({ group: 'integrations' });
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
    for (const id of ['passkeys', 'api-tokens']) {
      expect(groupFromHash(`#${id}`)).toEqual({
        group: 'integrations',
        anchor: id,
      });
    }
    for (const id of ['github-token', 'forgejo-token', 'forgejo-url']) {
      expect(groupFromHash(`#${id}`)).toEqual({
        group: 'connections',
        anchor: id,
      });
    }
    expect(groupFromHash('#timezone-select')).toEqual({
      group: 'display',
      anchor: 'timezone-select',
    });
  });
});
