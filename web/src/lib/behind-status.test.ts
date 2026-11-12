/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import fixture from '../../../tests/generated/behind-status.json';
import { autoMergeChip } from './wait-chip';

// The pull requests here are the ones the server builds
// (internal/api/behind_status_fixture_test.go), read the way the page reads
// them, so a field the server stops sending fails here rather than passing
// against a hand-written payload (#3601).
const { strict, notStrict } = fixture.pullRequests;

function chipOf(pr: typeof strict) {
  return autoMergeChip({
    state: pr.autoMerge.state as 'waiting' | 'stopped',
    code: (pr.autoMerge as { code?: string }).code,
    message: pr.autoMerge.message,
    draft: pr.draft,
    forge: pr.forge,
  });
}

describe('an armed pull request that is behind, as the server sends it', () => {
  test('where the base requires up-to-date branches it waits for the update', () => {
    const chip = chipOf(strict);

    expect(strict.behind).toBe(true);
    expect(chip?.label).toBe('Waiting for update');
    expect(chip?.detail).toBe('The branch must be up to date');
    expect(chip?.tooltip).toBe(strict.autoMerge.message);
    expect(strict.allowedActions.map((a) => a.action)).toContain(
      'update_branch',
    );
  });

  test('where it does not, being behind is not blamed', () => {
    const chip = chipOf(notStrict);

    expect(chip?.label).toBe('Waiting for CI');
    expect(chip?.label).not.toContain('update');
  });
});
