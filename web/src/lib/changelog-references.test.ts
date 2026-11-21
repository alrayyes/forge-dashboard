/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  cachedKind,
  projectReferences,
  referenceTitle,
} from './changelog-references';

describe('projectReferences', () => {
  test('reads the repository and forge from a GitHub release address', () => {
    const found = projectReferences(
      'https://github.com/alrayyes/forge-dashboard/releases/tag/v9.0.0',
    );
    expect(found?.repoUrl).toBe('https://github.com/alrayyes/forge-dashboard');
    expect(found?.forge).toBe('github');
  });

  test('no reference is tracked, so every one is asked of the forge', () => {
    const found = projectReferences(
      'https://github.com/alrayyes/forge-dashboard/releases/tag/v9.0.0',
    );
    expect(found?.tracked('alrayyes/forge-dashboard')).toBe(false);
    expect(found?.tracked('other/repo')).toBe(false);
  });

  test('is null for an address that is not a GitHub release', () => {
    expect(projectReferences('')).toBeNull();
    expect(projectReferences('https://example.com')).toBeNull();
    expect(
      projectReferences('https://git.example.org/o/r/releases/tag/v1'),
    ).toBeNull();
    expect(projectReferences('not a url')).toBeNull();
  });
});

describe('referenceTitle', () => {
  test('names an issue as an issue', () => {
    expect(referenceTitle('issue', 7)).toBe('Issue #7');
  });

  test('names a pull request as a pull request', () => {
    expect(referenceTitle('pullRequest', 7)).toBe('Pull request #7');
  });

  test('says issue while the kind is unknown', () => {
    expect(referenceTitle(undefined, 7)).toBe('Issue #7');
  });
});

describe('cachedKind', () => {
  const entry = (details: unknown) => ({ details, readAt: 0 });

  test('reads the kind the forge answered with', () => {
    expect(cachedKind(entry({ kind: 'pullRequest' }))).toBe('pullRequest');
    expect(cachedKind(entry({ kind: 'issue' }))).toBe('issue');
  });

  test('is undefined when the payload has no kind', () => {
    expect(cachedKind(entry({ title: 'x' }))).toBeUndefined();
  });

  test('is undefined when nothing is cached or the payload is empty', () => {
    expect(cachedKind(undefined)).toBeUndefined();
    expect(cachedKind(entry(null))).toBeUndefined();
  });
});
