/// <reference types="bun" />
import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

// The scans read only tracked files: agent worktrees under .claude/ hold whole
// copies of the repo, and walking them outlasted bun's 5 s default (#5028).
// Cheaper beats a longer timeout, so the default still ends a hung test.
const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: root })
  .stdout.toString()
  .split('\n')
  .filter(Boolean);

const trackedSources = (suffix: string, skip: string[]) =>
  tracked.filter(
    (f) =>
      f.endsWith(suffix) &&
      !f
        .split('/')
        .slice(0, -1)
        .some((d) => skip.includes(d)),
  );

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
  for (const rel of trackedSources('.go', ['web'])) {
    const dir = path.posix.dirname(rel);
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

// Files outside the package that `go test ./...` reads: fixtures and docs
// named by a `../` path in a test, either as one string or as
// filepath.Join("..", ...). Derived, so the next one is caught.
function goTestReads(): string[] {
  const out = new Set<string>();
  for (const rel of trackedSources('_test.go', ['web', 'integration'])) {
    const dir = path.posix.dirname(rel);
    const src = read(rel);
    const refs: string[] = [];
    for (const m of src.matchAll(/"((?:\.\.\/)+[^"\s]*)"/g)) refs.push(m[1]);
    for (const m of src.matchAll(/filepath\.Join\(((?:\s*"[^"]*"\s*,?)+)\)/g)) {
      const parts = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
      if (parts[0] === '..') refs.push(parts.join('/'));
    }
    for (const ref of refs) {
      const resolved = path.posix.normalize(path.posix.join(dir, ref));
      if (resolved.startsWith('..')) continue;
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path.join(root, resolved));
      } catch {
        continue; // not a path that exists: a string about paths
      }
      out.add(stat.isDirectory() ? `${resolved}/probe.file` : resolved);
    }
  }
  return [...out].sort();
}

const goTestReadsBefore = goTestReads();

// Agent worktrees under .claude/ hold whole copies of the repo. Reading them
// made these scans outlast bun's 5 s default on a busy machine (#5028).
test('the source scans ignore files git does not track', () => {
  // A dot directory, so a `go test ./...` running beside this skips it.
  const dir = mkdtempSync(path.join(root, '.scan-probe-'));
  const name = path.basename(dir);
  try {
    writeFileSync(
      path.join(dir, 'copy_test.go'),
      '//go:embed copy_test.go\nvar x = "../README.md"\n',
    );
    expect(goEmbedTargets()).not.toContain(`${name}/copy_test.go`);
    expect(goTestReads()).toEqual(goTestReadsBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every file a Go test reads from outside its package is a go test input', () => {
  const reads = goTestReads();
  // The known ones, so an empty or broken scan cannot pass.
  for (const f of [
    'docs/rate-limits.md',
    'api/openapi.yaml',
    'tests/generated/nav-counts.json',
  ])
    expect(reads).toContain(f);
  for (const f of reads) {
    expect({ f, hit: matches('test', f) }).toEqual({ f, hit: true });
  }
});

// What each job reads that nothing above derives. A glob dropped from a job
// fails here unless another glob covers the same files.
const mustMatch: Record<string, string[]> = {
  test: [
    'go.mod',
    'go.sum',
    'api/openapi.yaml',
    'cmd/forge-dashboard/main.go',
    'scripts/go-docker.sh',
    'docs/rate-limits.md',
    'tests/generated/behind-status.json',
    'lefthook.yml',
  ],
  'golangci-lint': [
    'go.mod',
    'go.sum',
    '.golangci.yml',
    '.golangci.yaml',
    'internal/api/server.go',
    'scripts/golangci-lint-docker.sh',
    'scripts/go-docker.sh',
  ],
  gomod: ['go.mod', 'go.sum', 'internal/api/server.go', 'scripts/go-docker.sh'],
  'gomod-tidy': [
    'go.mod',
    'go.sum',
    'internal/api/server.go',
    'scripts/go-docker.sh',
  ],
  storybook: [
    'web/src/a.svelte',
    'package.json',
    'bun.lock',
    'bunfig.toml',
    'scripts/storybook-screenshots.ts',
    'lefthook.yml',
  ],
  'component-tests': [
    'web/src/a.svelte',
    'package.json',
    'bun.lock',
    'bunfig.toml',
    'lefthook.yml',
  ],
  'docker-build': [
    'Dockerfile',
    'Dockerfile.release',
    '.dockerignore',
    'go.mod',
    'go.sum',
    'cmd/forge-dashboard/main.go',
    'internal/api/server.go',
    'api/openapi.yaml',
    'web/src/a.svelte',
    'lefthook.yml',
  ],
};
for (const [name, files] of Object.entries(mustMatch)) {
  test(`${name} runs for the files it reads`, () => {
    for (const f of files) {
      expect({ name, f, hit: matches(name, f) }).toEqual({
        name,
        f,
        hit: true,
      });
    }
  });
}

// Every tracked file the Go jobs or the image build read, by what the repo
// holds today. `cmd/**` is equivalent to `**/*.go` while cmd/ holds only Go
// files, and `internal/api/static/**` is equivalent to `internal/**`; the
// first would stop being true the day cmd/ gains a fixture, and this test
// would then fail for the narrower list.
test('Go jobs run for every tracked Go file', () => {
  const goFiles = tracked.filter((f) => f.endsWith('.go'));
  expect(goFiles.length).toBeGreaterThan(100);
  for (const name of [
    'test',
    'golangci-lint',
    'gomod',
    'gomod-tidy',
    'docker-build',
  ]) {
    const missed = goFiles.filter((f) => !matches(name, f));
    expect({ name, missed }).toEqual({ name, missed: [] });
  }
});

test('test and docker-build run for every tracked file under cmd/ and internal/', () => {
  const files = tracked.filter((f) => /^(cmd|internal)\//.test(f));
  expect(files.length).toBeGreaterThan(100);
  for (const name of ['test', 'docker-build']) {
    const missed = files.filter((f) => !matches(name, f));
    expect({ name, missed }).toEqual({ name, missed: [] });
  }
});
