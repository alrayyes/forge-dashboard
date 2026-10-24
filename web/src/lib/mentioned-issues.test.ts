/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  type MentionedIssue,
  mentionPillName,
  mentionPillText,
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
});
