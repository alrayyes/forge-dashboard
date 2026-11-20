/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dir, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

type Job = {
  name?: string;
  glob?: string | string[];
  jobs?: Job[];
  group?: { jobs: Job[] };
};
const flatten = (jobs: Job[]): Job[] =>
  jobs.flatMap((j) => (j.group ? flatten(j.group.jobs) : [j]));
const config = Bun.YAML.parse(read('lefthook.yml')) as {
  'pre-push': { jobs: Job[] };
};
const jobs = flatten(config['pre-push'].jobs);

// A pre-push job that is skipped when its inputs change is a check that only
// CI runs. These pin each job's glob list to the files the job really reads,
// derived from the repo rather than copied into the test.
function globsOf(name: string): Bun.Glob[] {
  const job = jobs.find((j) => j.name === name);
  if (!job?.glob) throw new Error(`job ${name} has no glob`);
  return [job.glob].flat().map((g) => new Bun.Glob(g));
}
const matches = (name: string, file: string) =>
  globsOf(name).some((g) => g.match(file));

// A source ending in / is a directory: any file in it must match.
const probe = (p: string) => (p.endsWith('/') ? `${p}probe.file` : p);

function dockerCopySources(): string[] {
  const out: string[] = [];
  for (const line of read('Dockerfile').split('\n')) {
    const m = line.match(/^COPY\s+(?!--from)(?:--\S+\s+)*(.+)$/);
    if (!m) continue;
    const parts = m[1].trim().split(/\s+/);
    parts.pop(); // destination
    for (const src of parts) if (src !== '.') out.push(src);
  }
  return out;
}

function goEmbedTargets(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', '.git', 'web'].includes(e.name)) walk(rel);
      } else if (e.name.endsWith('.go')) {
        for (const m of read(rel).matchAll(/^\/\/go:embed\s+(.+)$/gm)) {
          for (let t of m[1].trim().split(/\s+/)) {
            t = t.replace(/^all:/, '');
            const p = path.posix.join(dir, t);
            if (t.includes('*')) {
              const g = new Bun.Glob(p);
              for (const f of readdirSync(
                path.join(root, dir, path.posix.dirname(t)),
              ).map((f) => path.posix.join(dir, path.posix.dirname(t), f)))
                if (g.match(f)) out.push(f);
            } else out.push(p);
          }
        }
      }
    }
  };
  walk('.');
  return out;
}

test('every Dockerfile COPY source is a docker-build input', () => {
  const sources = dockerCopySources();
  expect(sources.length).toBeGreaterThan(5);
  for (const src of sources) {
    expect({ src, hit: matches('docker-build', probe(src)) }).toEqual({
      src,
      hit: true,
    });
  }
});

test('every go:embed target is a go test input', () => {
  const targets = goEmbedTargets();
  expect(targets.length).toBeGreaterThan(2);
  for (const t of targets) {
    const file = t.endsWith('static') ? `${t}/probe.file` : t;
    expect({ t, hit: matches('test', file) }).toEqual({ t, hit: true });
  }
});

test('the web build inputs are inputs of the jobs that build or run it', () => {
  for (const name of ['test', 'docker-build', 'storybook', 'component-tests']) {
    for (const f of [
      'web/src/a.svelte',
      'package.json',
      'bun.lock',
      'bunfig.toml',
    ]) {
      expect({ name, f, hit: matches(name, f) }).toEqual({
        name,
        f,
        hit: true,
      });
    }
  }
  for (const name of ['test', 'docker-build']) {
    for (const f of [
      'CHANGELOG.md',
      'scripts/sync-web-build.sh',
      'scripts/changelog-json.ts',
    ]) {
      expect({ name, f, hit: matches(name, f) }).toEqual({
        name,
        f,
        hit: true,
      });
    }
  }
});

test('storybook runs when a script it imports changes', () => {
  const src = read('scripts/storybook-screenshots.ts');
  const local = [...src.matchAll(/from '\.\/([\w-]+)'/g)].map(
    (m) => `scripts/${m[1]}.ts`,
  );
  expect(local.length).toBeGreaterThan(0);
  for (const f of ['scripts/storybook-screenshots.ts', ...local]) {
    expect({ f, hit: matches('storybook', f) }).toEqual({ f, hit: true });
  }
});

test('Go jobs run for a root-level Go file and for their scripts', () => {
  for (const name of [
    'test',
    'golangci-lint',
    'gomod',
    'gomod-tidy',
    'docker-build',
  ]) {
    // lefthook's `**/*.go` does not match a file at the root; `*.go` must be
    // listed beside it.
    const job = jobs.find((j) => j.name === name);
    expect({ name, root: [job?.glob].flat().includes('*.go') }).toEqual({
      name,
      root: true,
    });
  }
  expect(matches('test', 'scripts/go-docker.sh')).toBe(true);
  expect(matches('golangci-lint', 'scripts/golangci-lint-docker.sh')).toBe(
    true,
  );
});
