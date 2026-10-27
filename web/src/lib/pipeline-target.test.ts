/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { pipelineTarget } from './pipeline-target';

describe('pipelineTarget', () => {
  test('a pull request and a branch get the same shape', () => {
    const pr = pipelineTarget({
      forge: 'forgejo',
      fullName: 'o/r',
      number: 12,
      signature: 's',
    });
    const branch = pipelineTarget({
      forge: 'forgejo',
      fullName: 'o/r',
      branch: 'main',
      signature: 's',
      runUrl: 'https://f.example/o/r/actions/runs/3',
    });
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect(Object.keys(pr).sort(byName)).toEqual(
      Object.keys(branch).sort(byName),
    );
    expect(pr.forgeName).toBe(branch.forgeName);
  });

  test('names the pull request endpoint and subtitle', () => {
    const t = pipelineTarget({
      forge: 'github',
      fullName: 'o/r',
      number: 12,
      signature: 's',
    });
    expect(t.subtitle).toBe('o/r#12');
    expect(t.checksUrl).toBe(
      '/api/pull-requests/checks?forge=github&fullName=o%2Fr&number=12',
    );
    expect(t.forgeName).toBe('GitHub');
  });

  test('names the branch endpoint and subtitle', () => {
    const t = pipelineTarget({
      forge: 'forgejo',
      fullName: 'o/r',
      branch: 'main',
      signature: 's',
    });
    expect(t.subtitle).toBe('o/r · main');
    expect(t.checksUrl).toBe(
      '/api/main-branches/checks?forge=forgejo&fullName=o%2Fr',
    );
  });
});
