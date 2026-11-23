import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workflowPath = path.join(
  import.meta.dir,
  '..',
  '.github',
  'workflows',
  'pin-playwright-image.yml',
);
const text = readFileSync(workflowPath, 'utf8');

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = {
  if?: string;
  permissions?: Record<string, string>;
  steps: Step[];
};
const doc = Bun.YAML.parse(text) as {
  on: { pull_request?: { paths?: string[] } };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, Job>;
};
const pin = doc.jobs.pin as Job;
const step = (name: string): Step => {
  const found = pin.steps.find((s) => s.name === name);
  if (!found) throw new Error(`no step named ${name}`);
  return found;
};

describe('pin-playwright-image.yml shape', () => {
  test('runs on pull requests that touch package.json', () => {
    expect(doc.on.pull_request?.paths).toEqual(['package.json']);
  });

  test('only acts for Dependabot', () => {
    expect(pin.if).toBe("github.actor == 'dependabot[bot]'");
  });

  test('keys the concurrency group on the actor, so the pushed run cannot cancel this one', () => {
    expect(doc.concurrency?.group).toContain('${{ github.actor }}');
    expect(doc.concurrency?.group).toContain(
      '${{ github.event.pull_request.number }}',
    );
    expect(doc.concurrency?.['cancel-in-progress']).toBe(true);
  });

  test('has one job and hands nothing over as an artifact', () => {
    expect(Object.keys(doc.jobs)).toEqual(['pin']);
    expect(text).not.toContain('upload-artifact');
    expect(text).not.toContain('download-artifact');
  });

  test('runs no script from the pull request', () => {
    expect(text).not.toContain('bun scripts/');
    expect(text).not.toContain('setup-bun');
    for (const s of pin.steps.filter((s) => !s.name?.startsWith('Comment'))) {
      expect(s.run ?? '').not.toMatch(/\bbun\b|\bnode\b|\.\/scripts/);
    }
  });

  test('keeps the token to the check and the push', () => {
    const holders = pin.steps
      .filter((s) => JSON.stringify(s).includes('secrets.RELEASE_TOKEN'))
      .map((s) => s.name);
    expect(holders).toEqual([
      'Check RELEASE_TOKEN reaches Dependabot runs',
      'Commit the new pin',
    ]);
  });

  test('gives the default token only the permissions the comment needs', () => {
    expect(pin.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
    });
    expect(step('Comment on the pull request').env?.GH_TOKEN).toBe(
      '${{ secrets.GITHUB_TOKEN }}',
    );
  });

  test('masks the derived credential before the push', () => {
    const run = step('Commit the new pin').run ?? '';
    expect(run.indexOf('::add-mask::$auth')).toBeGreaterThan(-1);
    expect(run.indexOf('::add-mask::$auth')).toBeLessThan(
      run.indexOf('git -c'),
    );
  });

  test('checks out the head SHA without keeping credentials', () => {
    const checkout = pin.steps.find((s) =>
      s.uses?.startsWith('actions/checkout@'),
    );
    expect(checkout?.with?.ref).toBe(
      '${{ github.event.pull_request.head.sha }}',
    );
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  test('pins every action to a full commit SHA', () => {
    for (const s of pin.steps.filter((s) => s.uses)) {
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test('commits as the actions bot', () => {
    expect(step('Commit the new pin').run).toContain(
      'git config user.name "github-actions[bot]"',
    );
  });
});

// The rewrite step, run for real. The script is the workflow's own `run:`
// text, so what these tests exercise is what the job executes. Only docker is
// faked, since the registry isn't ours to call from a test.
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OLD = `ghcr.io/alrayyes/ci-playwright:1.64.0@sha256:${'b'.repeat(64)}`;
const NEW = `ghcr.io/alrayyes/ci-playwright:1.65.1@${DIGEST}`;
const line = (image: string, tail = '') => `      image: ${image}${tail}\n`;
const ciWith = (lines: string[]) =>
  `jobs:\n  t:\n    container:\n${lines.join('')}`;

// A git hook exports GIT_DIR and friends, which would point the temp repo's
// commands at the real repository. Drop them so the test only touches its own.
const cleanEnv = (): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );

type Repo = Record<string, string>;
const defaults = (): Repo => ({
  'package.json': JSON.stringify({
    devDependencies: { '@playwright/test': '1.65.1' },
  }),
  '.github/workflows/ci.yml': ciWith([line(OLD), line(OLD), line(OLD)]),
  '.github/workflows/release.yml': ciWith([line(OLD)]),
});

function runRewrite(
  files: Repo,
  { digestLine = `Digest:    ${DIGEST}`, dockerFails = false } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pin-wf-'));
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: cleanEnv() });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');

  const bin = path.join(dir, '.fake-bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'docker'),
    dockerFails
      ? '#!/bin/sh\necho "manifest unknown" >&2\nexit 1\n'
      : `#!/bin/sh\necho "Name:      $4"\necho "${digestLine}"\n`,
  );
  chmodSync(path.join(bin, 'docker'), 0o755);

  const output = path.join(dir, '.github-output');
  writeFileSync(output, '');
  const script = step('Rewrite the image pins').run ?? '';
  const result = spawnSync('bash', ['-e', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...cleanEnv(),
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
    },
  });
  const read = (file: string) => readFileSync(path.join(dir, file), 'utf8');
  return {
    status: result.status,
    stderr: `${result.stdout}${result.stderr}`,
    output: readFileSync(output, 'utf8'),
    ci: read('.github/workflows/ci.yml'),
    release: read('.github/workflows/release.yml'),
    changed: git('diff', '--name-only').stdout.trim(),
  };
}

describe('the rewrite step', () => {
  test('moves all four image lines and reports the version', () => {
    const r = runRewrite(defaults());
    expect(r.status).toBe(0);
    expect(r.ci).toBe(ciWith([line(NEW), line(NEW), line(NEW)]));
    expect(r.release).toBe(ciWith([line(NEW)]));
    expect(r.output).toContain('version=1.65.1');
  });

  test('keeps a trailing comment on an image line', () => {
    const files = defaults();
    files['.github/workflows/ci.yml'] = ciWith([
      line(OLD, ' # keep me'),
      line(OLD),
      line(OLD),
    ]);
    const r = runRewrite(files);
    expect(r.status).toBe(0);
    expect(r.ci).toContain(`image: ${NEW} # keep me\n`);
  });

  test('does nothing, and says so, when the pin is already right', () => {
    const files = defaults();
    files['.github/workflows/ci.yml'] = ciWith([
      line(NEW),
      line(NEW),
      line(NEW),
    ]);
    files['.github/workflows/release.yml'] = ciWith([line(NEW)]);
    const r = runRewrite(files);
    expect(r.status).toBe(0);
    expect(r.changed).toBe('');
    expect(r.output).toContain('version=\n');
  });

  test('fails on an extra image line', () => {
    const files = defaults();
    files['.github/workflows/ci.yml'] = ciWith([
      line(OLD),
      line(OLD),
      line(OLD),
      line(OLD),
    ]);
    const r = runRewrite(files);
    expect(r.status).not.toBe(0);
    expect(r.changed).toBe('');
  });

  test('fails on a missing image line', () => {
    const files = defaults();
    files['.github/workflows/release.yml'] = ciWith([]);
    expect(runRewrite(files).status).not.toBe(0);
  });

  test('fails on an image line the sed would skip', () => {
    const files = defaults();
    files['.github/workflows/ci.yml'] = ciWith([
      line(OLD),
      line(OLD),
      `      image: "${OLD}"\n`,
    ]);
    const r = runRewrite(files);
    expect(r.status).not.toBe(0);
    expect(r.changed).toBe('');
  });

  test('leaves another workflow with the same image alone', () => {
    const files = defaults();
    files['.github/workflows/other.yml'] = ciWith([line(OLD)]);
    const r = runRewrite(files);
    expect(r.status).toBe(0);
    expect(r.changed).toBe(
      '.github/workflows/ci.yml\n.github/workflows/release.yml',
    );
  });

  test.each([
    ['a range', '^1.65.1'],
    ['a tag', 'latest'],
    ['a shell payload', '1.65.1$(touch pwned)'],
    ['an sed delimiter', '1.65.1#x'],
  ])('fails on %s as the Playwright version', (_name, version) => {
    const files = defaults();
    files['package.json'] = JSON.stringify({
      devDependencies: { '@playwright/test': version },
    });
    const r = runRewrite(files);
    expect(r.status).not.toBe(0);
    expect(r.changed).toBe('');
  });

  test('fails when package.json pins no Playwright', () => {
    const files = defaults();
    files['package.json'] = '{}';
    expect(runRewrite(files).status).not.toBe(0);
  });

  test.each([
    ['a short digest', 'Digest:    sha256:abc'],
    ['an upper-case digest', `Digest:    sha256:${'A'.repeat(64)}`],
    ['a digest carrying sed syntax', `Digest:    sha256:${'a'.repeat(63)}#`],
    ['no digest line', 'Name: x'],
  ])('fails on %s from the registry', (_name, digestLine) => {
    const r = runRewrite(defaults(), { digestLine });
    expect(r.status).not.toBe(0);
    expect(r.changed).toBe('');
  });

  test('fails when the registry has no such tag', () => {
    const r = runRewrite(defaults(), { dockerFails: true });
    expect(r.status).not.toBe(0);
    expect(r.changed).toBe('');
  });
});
