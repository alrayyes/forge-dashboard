import { afterEach, describe, expect, test } from 'bun:test';
import { appHoldsAutoMerge, forgeHoldsArmed } from './auto-merge-adapter';
import { registerForgeCapabilities, resetForgeCapabilities } from './forges';

afterEach(resetForgeCapabilities);

describe('who holds an armed auto-merge', () => {
  test('the app holds it where the capability says so', () => {
    expect(appHoldsAutoMerge('forgejo')).toBe(true);
    expect(appHoldsAutoMerge('github')).toBe(false);
    expect(appHoldsAutoMerge('nowhere')).toBe(false);
  });

  test('a forge the server describes as app-held is app-held, whatever its name', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { autoMergeHeldByApp: true } },
    ]);

    expect(appHoldsAutoMerge('gitea')).toBe(true);
    expect(forgeHoldsArmed({ forge: 'gitea', autoMergeHeldBy: 'forge' })).toBe(
      true,
    );
  });

  test('a merge the forge holds is cancelled on the forge only where the app does the merging', () => {
    expect(
      forgeHoldsArmed({ forge: 'forgejo', autoMergeHeldBy: 'forge' }),
    ).toBe(true);
    expect(
      forgeHoldsArmed({ forge: 'forgejo', autoMergeHeldBy: 'dashboard' }),
    ).toBe(false);
    expect(forgeHoldsArmed({ forge: 'github', autoMergeHeldBy: 'forge' })).toBe(
      false,
    );
  });
});
