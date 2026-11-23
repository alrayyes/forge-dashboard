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
const doc = Bun.YAML.parse(text) as {
  on: { pull_request?: { paths?: string[] } };
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    { if?: string; permissions?: Record<string, string>; steps: Step[] }
  >;
};
const job = doc.jobs.pin;
const steps = job?.steps ?? [];

describe('pin-playwright-image.yml', () => {
  test('runs on pull requests that touch package.json', () => {
    expect(doc.on.pull_request?.paths).toEqual(['package.json']);
  });

  test('only acts for Dependabot', () => {
    expect(job?.if).toBe("github.actor == 'dependabot[bot]'");
  });

  test('pushes with RELEASE_TOKEN so the new head gets CI', () => {
    const push = steps.find((s) => s.name === 'Commit the new pin');
    expect(push?.env?.RELEASE_TOKEN).toBe('${{ secrets.RELEASE_TOKEN }}');
  });

  test('keeps the token away from every step but the push and its check', () => {
    const holders = steps
      .filter((s) => JSON.stringify(s).includes('secrets.RELEASE_TOKEN'))
      .map((s) => s.name);
    expect(holders).toEqual([
      'Check RELEASE_TOKEN reaches Dependabot runs',
      'Commit the new pin',
    ]);
  });

  test('checks out the head SHA without keeping credentials', () => {
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe(
      '${{ github.event.pull_request.head.sha }}',
    );
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  test('pins every action to a full commit SHA', () => {
    for (const s of steps.filter((s) => s.uses)) {
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test('runs the repin script from this repo', () => {
    expect(text).toContain('bun scripts/pin-playwright-image.ts');
  });

  test('says in a comment what it changed, with the default token', () => {
    const comment = steps.find((s) => s.name === 'Comment on the pull request');
    expect(comment?.run).toContain('gh pr comment');
    expect(comment?.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(job?.permissions?.['pull-requests']).toBe('write');
  });

  test('never commits as a person', () => {
    expect(text).toContain('git config user.name "github-actions[bot]"');
  });
});
