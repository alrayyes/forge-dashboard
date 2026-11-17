import { afterEach, describe, expect, test } from 'bun:test';
import {
  approveLinkCopy,
  autoMergeGroupNote,
  forgeNameList,
  pageDescription,
  scheduledOnCopy,
} from './forge-copy';
import { registerForgeCapabilities, resetForgeCapabilities } from './forges';

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
