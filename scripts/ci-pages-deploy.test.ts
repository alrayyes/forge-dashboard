import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Guards the `pages` job's deploy steps in ci.yml (#4705): a per-attempt
// artifact name, and a bounded retry of deploy-pages that still fails red.
type Step = {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, string>;
  env?: Record<string, string>;
};
const doc = Bun.YAML.parse(
  readFileSync(
    path.join(import.meta.dir, '..', '.github', 'workflows', 'ci.yml'),
    'utf8',
  ),
) as { jobs: Record<string, { steps: Step[] }> };

const steps = doc.jobs.pages.steps;
const upload = steps.find((s) =>
  s.uses?.startsWith('actions/upload-pages-artifact@'),
);
const deploys = steps.filter((s) =>
  s.uses?.startsWith('actions/deploy-pages@'),
);
const coverage = steps.find((s) => s.name?.startsWith('Live coverage.xml'));

describe('pages job deploy', () => {
  test('uploads under a name that is unique per attempt', () => {
    expect(upload?.with?.name).toContain('${{ github.run_attempt }}');
  });

  test('every deploy attempt deploys exactly the uploaded artifact', () => {
    expect(deploys.length).toBeGreaterThanOrEqual(2);
    for (const d of deploys) {
      expect(d.with?.artifact_name).toBe(upload?.with?.name);
    }
  });

  test('every deploy-pages is pinned to a full SHA', () => {
    for (const d of deploys) {
      expect(d.uses).toMatch(/^actions\/deploy-pages@[0-9a-f]{40}$/);
    }
  });

  test('only the last attempt can fail the job, so the real error shows', () => {
    for (const d of deploys.slice(0, -1)) {
      expect(d['continue-on-error']).toBe(true);
    }
    expect(deploys.at(-1)?.['continue-on-error']).toBeUndefined();
  });

  test('each retry runs only after the previous attempt failed', () => {
    deploys.slice(1).forEach((d, i) => {
      const prev = deploys[i];
      expect(prev.id).toBeTruthy();
      expect(d.if).toContain(`steps.${prev.id}.outcome == 'failure'`);
    });
  });

  test('a pause separates attempts, and runs only when one failed', () => {
    for (const d of deploys.slice(0, -1)) {
      const pause = steps[steps.indexOf(d) + 1];
      expect(pause.run).toMatch(/^sleep \d+/);
      expect(pause.if).toContain(`steps.${d.id}.outcome == 'failure'`);
    }
  });

  test('the live coverage check reads the URL of whichever attempt ran', () => {
    for (const d of deploys) {
      expect(coverage?.env?.PAGE_URL).toContain(
        `steps.${d.id}.outputs.page_url`,
      );
    }
    expect(steps.indexOf(coverage as Step)).toBeGreaterThan(
      steps.indexOf(deploys.at(-1) as Step),
    );
  });
});
