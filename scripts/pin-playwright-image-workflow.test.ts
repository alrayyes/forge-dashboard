/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// #4671: the pin-playwright-image workflow pushes to Dependabot's branch. A
// push made with GITHUB_TOKEN starts no workflow run, so the push has to use
// RELEASE_TOKEN or the repinned head gets no CI. That token reaches the push
// step alone, and the checkout is pinned to the head SHA. Ported from
// movie-planner-web's workflow-baseline tests (#993).
const file = path.join(
  import.meta.dir,
  '..',
  '.github',
  'workflows',
  'pin-playwright-image.yml',
);
const text = readFileSync(file, 'utf8');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = {
  if?: string;
  needs?: string;
  permissions?: Record<string, string>;
  steps: Step[];
};
const doc = Bun.YAML.parse(text) as {
  on: { pull_request?: { paths?: string[] } };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, Job>;
};
// The PR's own script runs in `repin`, which holds no secret. `push` holds the
// token and runs nothing from the PR: it applies a validated patch.
const repin = doc.jobs.repin as Job;
const push = doc.jobs.push as Job;

describe('pin-playwright-image.yml', () => {
  test('runs on pull requests that touch package.json', () => {
    expect(doc.on.pull_request?.paths).toEqual(['package.json']);
  });

  test('only acts for Dependabot, in both jobs', () => {
    expect(repin.if).toBe("github.actor == 'dependabot[bot]'");
    expect(push.if).toContain("github.actor == 'dependabot[bot]'");
  });

  test('keys the concurrency group on the actor, so the pushed run cannot cancel this one', () => {
    expect(doc.concurrency?.group).toContain('${{ github.actor }}');
    expect(doc.concurrency?.group).toContain(
      '${{ github.event.pull_request.number }}',
    );
  });

  test('the job that runs the PR script has no secret and a read-only token', () => {
    expect(JSON.stringify(repin)).not.toContain('secrets.');
    expect(repin.permissions).toEqual({ contents: 'read' });
  });

  test('the token job runs no script from the PR', () => {
    expect(push.needs).toBe('repin');
    expect(push.permissions?.contents).toBe('read');
    expect(JSON.stringify(push)).not.toContain(
      'scripts/pin-playwright-image.ts',
    );
    expect(JSON.stringify(push)).not.toContain('setup-bun');
  });

  test('pushes with RELEASE_TOKEN so the new head gets CI', () => {
    const step = push.steps.find((s) => s.name === 'Commit the new pin');
    expect(step?.env?.RELEASE_TOKEN).toBe('${{ secrets.RELEASE_TOKEN }}');
  });

  test('keeps the token to the push step and its check', () => {
    const holders = push.steps
      .filter((s) => JSON.stringify(s).includes('secrets.RELEASE_TOKEN'))
      .map((s) => s.name);
    expect(holders).toEqual([
      'Check RELEASE_TOKEN reaches Dependabot runs',
      'Commit the new pin',
    ]);
  });

  test('masks the derived credential before the push', () => {
    const step = push.steps.find((s) => s.name === 'Commit the new pin');
    expect(step?.run).toContain('::add-mask::$auth');
    expect(step?.run?.indexOf('::add-mask::')).toBeLessThan(
      step?.run?.indexOf('git -c') ?? 0,
    );
  });

  test('checks out the head SHA without keeping credentials, in both jobs', () => {
    for (const job of [repin, push]) {
      const checkout = job.steps.find((s) =>
        s.uses?.startsWith('actions/checkout@'),
      );
      expect(checkout?.with?.ref).toBe(
        '${{ github.event.pull_request.head.sha }}',
      );
      expect(checkout?.with?.['persist-credentials']).toBe(false);
    }
  });

  test('pins every action to a full commit SHA', () => {
    for (const s of [...repin.steps, ...push.steps].filter((s) => s.uses)) {
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test('runs the repin script from this repo, in the job with no secret', () => {
    expect(JSON.stringify(repin)).toContain(
      'bun scripts/pin-playwright-image.ts',
    );
  });

  test('only applies a patch that touches image lines', () => {
    const step = push.steps.find((s) => s.name === 'Check the patch');
    expect(step?.run).toContain('ci-playwright');
    expect(step?.run).toContain('exit "$fail"');
  });

  test('says in a comment what it changed, with the default token', () => {
    const comment = push.steps.find(
      (s) => s.name === 'Comment on the pull request',
    );
    expect(comment?.run).toContain('gh pr comment');
    expect(comment?.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(push.permissions?.['pull-requests']).toBe('write');
  });

  test('never commits as a person', () => {
    expect(text).toContain('git config user.name "github-actions[bot]"');
  });
});
