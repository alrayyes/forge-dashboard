/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  type MentionedIssue,
  mentionDialogName,
  mentionPillName,
  mentionPillText,
  mentionPillTitle,
} from './mentioned-issues';

// The pill a pull request dialog draws for a ticket it mentions. The server
// reads the text and says whether the dashboard tracks the ticket; this only
// words the pill. The page wiring is mentioned-tickets.spec.ts.

const mention = (overrides: Partial<MentionedIssue> = {}): MentionedIssue => ({
  repo: 'alrayyes/app',
  number: 12,
  url: 'https://github.com/alrayyes/app/issues/12',
  pageUrl: '/issues.html?issue=github/alrayyes/app/12',
  tracked: true,
  ...overrides,
});

describe('mentionPillText', () => {
  test('is the bare number for the pull request own repo, ignoring case', () => {
    expect(mentionPillText(mention(), 'Alrayyes/App')).toBe('Mentions #12');
  });

  test('names the repo when the ticket is in another one', () => {
    expect(
      mentionPillText(mention({ repo: 'alrayyes/lib' }), 'alrayyes/app'),
    ).toBe('Mentions alrayyes/lib#12');
  });
});

describe('mentionPillName', () => {
  test('contains the visible text and says a tracked ticket opens here', () => {
    expect(mentionPillName(mention(), 'alrayyes/app')).toBe(
      'Mentions #12, opens the issue',
    );
  });

  test('says an untracked ticket opens on the forge', () => {
    expect(mentionPillName(mention({ tracked: false }), 'alrayyes/app')).toBe(
      'Mentions #12, opens on the forge',
    );
  });

  // #5089: not on the board, but its repository is tracked, so the pill opens
  // the dialog and says so.
  test('says an unlisted ticket of a tracked repository opens its details', () => {
    const unlisted = mention({ tracked: false });
    expect(mentionPillName(unlisted, 'alrayyes/app', true)).toBe(
      'Mentions #12, opens its details',
    );
    expect(mentionDialogName(unlisted, 'alrayyes/app', true)).toBe(
      'Mentions: #12, opens its details',
    );
  });
});

describe('mentionDialogName', () => {
  test('leads with the relation and says where the pill goes', () => {
    expect(mentionDialogName(mention(), 'alrayyes/app')).toBe(
      'Mentions: #12, opens the issue',
    );
    expect(
      mentionDialogName(
        mention({ repo: 'alrayyes/lib', tracked: false }),
        'alrayyes/app',
      ),
    ).toBe('Mentions: alrayyes/lib#12, opens on the forge');
  });
});

describe('mentionPillTitle', () => {
  test('is the title, then what the pill does', () => {
    expect(mentionPillTitle(mention({ title: 'Show titles' }))).toBe(
      'Show titles\nMentioned here, does not close it',
    );
  });

  test('is nothing without a title, as before', () => {
    expect(mentionPillTitle(mention())).toBeUndefined();
    expect(mentionPillTitle(mention({ title: ' ' }))).toBeUndefined();
  });
});
