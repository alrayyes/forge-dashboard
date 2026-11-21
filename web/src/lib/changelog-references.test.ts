/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { projectReferences } from './changelog-references';

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
