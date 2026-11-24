import { afterEach, describe, expect, test } from 'bun:test';
import {
  appConnectionCopy,
  appHeldAutoMergeCopy,
  approveLinkCopy,
  autoMergeGroupNote,
  connectionsCaption,
  forgeNameList,
  noReposCopy,
  pageDescription,
  scheduledOnCopy,
  settingsDescription,
} from './forge-copy';
import {
  FORGE_LABELS,
  forgesWhere,
  registerForgeCapabilities,
  resetForgeCapabilities,
} from './forges';

afterEach(resetForgeCapabilities);

describe('forge copy comes from the label', () => {
  test('the approve link names the forge it opens', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { label: 'Gitea' } },
    ]);

    expect(approveLinkCopy('gitea')).toEqual({
      text: 'Approve on Gitea',
      ariaLabel: 'Approve on Gitea (opens the checks page in a new tab)',
    });
    expect(approveLinkCopy('github').text).toBe('Approve on GitHub');
  });

  test('a forge with no label falls back to its id', () => {
    expect(approveLinkCopy('mystery').text).toBe('Approve on mystery');
  });

  test('the scheduled-on strings use the label', () => {
    registerForgeCapabilities([
      { forge: 'forgejo', capabilities: { label: 'Codeberg' } },
    ]);

    expect(scheduledOnCopy('forgejo')).toEqual({
      note: 'Scheduled on Codeberg',
      cancelled: 'Merge scheduled on Codeberg cancelled.',
      cancelling: 'Cancelling the merge scheduled on Codeberg…',
      cancelLabel: 'Cancel auto-merge scheduled on Codeberg',
      cancelTitle: 'Cancels the merge scheduled on Codeberg.',
    });
  });

  test('the group note names the forge, twice', () => {
    registerForgeCapabilities([
      { forge: 'forgejo', capabilities: { label: 'Codeberg' } },
    ]);

    expect(autoMergeGroupNote('forgejo')).toBe(
      'Auto-merge on Codeberg is handled by Forge Dashboard, not Codeberg itself. Manage it in ',
    );
  });

  test('a list of names reads as prose', () => {
    expect(forgeNameList(['GitHub'])).toBe('GitHub');
    expect(forgeNameList(['GitHub', 'Forgejo'])).toBe('GitHub and Forgejo');
    expect(forgeNameList(['A', 'B', 'C'])).toBe('A, B and C');
  });

  test('the empty webhooks state names every forge it can take credentials for', () => {
    expect(noReposCopy()).toBe(
      'Nothing tracked yet — save GitHub or Forgejo credentials in Settings first.',
    );
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { label: 'Gitea' } },
    ]);
    expect(noReposCopy()).toBe(
      'Nothing tracked yet — save GitHub, Forgejo or Gitea credentials in Settings first.',
    );
  });

  test('page descriptions name every forge the app knows', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { label: 'Gitea' } },
    ]);

    expect(pageDescription('issues')).toBe(
      'Open issues across your GitHub, Forgejo and Gitea repositories, in one list.',
    );
    expect(pageDescription('pulls')).toContain(
      'across your GitHub, Forgejo and Gitea repositories',
    );
    expect(pageDescription('releases')).toContain('Merge and Update branch');
    expect(pageDescription('bots')).toContain('Dependabot and Renovate');
  });
});

describe('appConnectionCopy', () => {
  test('keeps the GitHub wording for GitHub', () => {
    expect(appConnectionCopy('github')).toEqual({
      dependabotNeedsToken:
        'Dependabot needs a personal access token when a GitHub App is connected.',
    });
  });

  test('an unlisted forge reads with its own label, not GitHub', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { label: 'Gitea' } },
    ]);
    const copy = appConnectionCopy('gitea');
    expect(copy.dependabotNeedsToken).toContain(
      'when a Gitea App is connected',
    );
    expect(JSON.stringify(copy)).not.toContain('GitHub');
  });
});

describe('settings copy comes from the label', () => {
  test('the Connections caption and page description list every forge', () => {
    expect(connectionsCaption()).toBe('GitHub, Forgejo');
    expect(settingsDescription()).toContain('GitHub and Forgejo connections');
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { label: 'Gitea' } },
    ]);
    expect(connectionsCaption()).toBe('GitHub, Forgejo, Gitea');
    expect(settingsDescription()).toContain(
      'GitHub, Forgejo and Gitea connections',
    );
  });

  test('the auto-merge card names the forge that holds the merge', () => {
    registerForgeCapabilities([
      { forge: 'forgejo', capabilities: { label: 'Codeberg' } },
    ]);
    const c = appHeldAutoMergeCopy('forgejo');

    expect(c.heading).toBe('Codeberg auto-merge');
    expect(c.intro).toBe(
      "Auto-merge on Codeberg is handled by Forge Dashboard, not Codeberg itself. Codeberg's own scheduled merge can't be read back, so this app keeps the intent and does the merging.",
    );
    expect(c.items.join(' ')).not.toContain('Forgejo');
    expect(c.items.join(' ')).toContain('Codeberg');
  });
});

describe('settings copy with fewer forges', () => {
  test('one forge reads without a conjunction, none without a gap', () => {
    for (const k of Object.keys(FORGE_LABELS)) delete FORGE_LABELS[k];
    expect(connectionsCaption()).toBe('');
    expect(settingsDescription()).toBe(
      'Your appearance, connections, pull request behavior, webhooks, passkeys and API tokens.',
    );
    FORGE_LABELS.github = 'GitHub';
    expect(connectionsCaption()).toBe('GitHub');
    expect(settingsDescription()).toContain(
      'Your appearance, GitHub connections,',
    );
  });
});

describe('forgesWhere', () => {
  test('is empty when no forge has the flag', () => {
    registerForgeCapabilities([
      { forge: 'forgejo', capabilities: { autoMergeHeldByApp: false } },
    ]);
    expect(forgesWhere('autoMergeHeldByApp')).toEqual([]);
  });

  test('lists several forges in registered order', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { autoMergeHeldByApp: true } },
    ]);
    expect(forgesWhere('autoMergeHeldByApp')).toEqual(['forgejo', 'gitea']);
  });

  test('an unknown forge never has a flag', () => {
    expect(forgesWhere('autoMergeHeldByApp')).not.toContain('mystery');
  });

  test('lists the forges that hold auto-merge in the app', () => {
    expect(forgesWhere('autoMergeHeldByApp')).toEqual(['forgejo']);
  });
});

test('one auto-merge card per forge that holds the merge', () => {
  registerForgeCapabilities([
    {
      forge: 'gitea',
      capabilities: { label: 'Gitea', autoMergeHeldByApp: true },
    },
  ]);
  const headings = forgesWhere('autoMergeHeldByApp').map(
    (f) => appHeldAutoMergeCopy(f).heading,
  );
  expect(headings).toEqual(['Forgejo auto-merge', 'Gitea auto-merge']);
});
