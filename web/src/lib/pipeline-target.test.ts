/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { factsOf } from './check-facts-fixture';
import { pipelineTarget } from './pipeline-target';
import { checkControl } from './run-log';

describe('pipelineTarget', () => {
  test('a pull request and a branch get the same shape', () => {
    const pr = pipelineTarget({
      forge: 'forgejo',
      fullName: 'o/r',
      number: 12,
    });
    const branch = pipelineTarget({
      forge: 'forgejo',
      fullName: 'o/r',
      branch: 'main',
      runUrl: 'https://f.example/o/r/actions/runs/3',
    });
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect(Object.keys(pr).sort(byName)).toEqual(
      Object.keys(branch).sort(byName),
    );
    expect(pr.forgeName).toBe(branch.forgeName);
  });

  test('a check gets the same control from either target', () => {
    const states = ['success', 'failure', 'running', 'queued', 'skipped'];
    for (const forge of ['github', 'forgejo']) {
      const pr = pipelineTarget({ forge, fullName: 'o/r', number: 1 });
      const branch = pipelineTarget({
        forge,
        fullName: 'o/r',
        branch: 'main',
      });
      for (const state of states) {
        const check = {
          ...factsOf(state),
          url: 'https://f.example/r/1',
          jobId: 7,
        };
        expect(checkControl(check, branch.repo)).toBe(
          checkControl(check, pr.repo),
        );
      }
      expect(
        checkControl(
          {
            status: 'completed',
            conclusion: 'success',
            url: 'https://f.example/r/1',
            jobId: 7,
          },
          branch.repo,
        ),
      ).not.toBe('none');
    }
  });

  test('names the pull request subject and subtitle', () => {
    const t = pipelineTarget({ forge: 'github', fullName: 'o/r', number: 12 });
    expect(t.subtitle).toBe('o/r#12');
    expect(t.subject).toEqual({
      kind: 'pull_request',
      forge: 'github',
      fullName: 'o/r',
      number: 12,
    });
    expect(t.repo).toEqual({ forge: 'github', fullName: 'o/r' });
    expect(t.forgeName).toBe('GitHub');
  });

  test('names the branch subject and subtitle', () => {
    const t = pipelineTarget({
      forge: 'forgejo',
      fullName: 'o/r',
      branch: 'main',
    });
    expect(t.subtitle).toBe('o/r · main');
    expect(t.subject).toEqual({
      kind: 'main_branch',
      forge: 'forgejo',
      fullName: 'o/r',
    });
  });
});
