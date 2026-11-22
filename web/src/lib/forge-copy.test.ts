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
  permissionsNotReportedCopy,
  scheduledOnCopy,
  settingsDescription,
} from './forge-copy';
import {
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
      disarmLabel: 'Disarm the merge scheduled on Codeberg',
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

describe('permissionsNotReportedCopy', () => {
  test('names the forge by its label', () => {
    expect(permissionsNotReportedCopy('forgejo')).toBe(
      "Forgejo didn't report your access on this repo, so the dashboard can't tell if you can manage its webhooks.",
    );
  });

  test('a registered third forge reads with its own label', () => {
    registerForgeCapabilities([
      {
        forge: 'gitea',
        capabilities: { label: 'Gitea', reportsRepoPermissions: true },
      },
    ]);

    expect(permissionsNotReportedCopy('gitea')).toStartWith(
      "Gitea didn't report your access",
    );
  });
});

describe('appConnectionCopy', () => {
  test('keeps the GitHub wording for GitHub', () => {
    expect(appConnectionCopy('github')).toEqual({
      missingWebhookPermission:
        'Give your GitHub App the Webhooks (read and write) permission, then accept it on the installation, or ',
      dependabotNeedsToken:
        'Dependabot needs a personal access token when a GitHub App is connected.',
    });
  });

  test('an unlisted forge reads with its own label, not GitHub', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { label: 'Gitea' } },
    ]);
    const copy = appConnectionCopy('gitea');
    expect(copy.missingWebhookPermission).toContain('Give your Gitea App');
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

describe('forgesWhere', () => {
  test('lists the forges that hold auto-merge in the app', () => {
    expect(forgesWhere('autoMergeHeldByApp')).toEqual(['forgejo']);
  });
});
