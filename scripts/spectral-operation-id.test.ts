/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The wrapper-collision rule uppercases an operationId's first letter, which
// matches oapi-codegen's PascalCase only while the id is camelCase
// alphanumeric. A rule holds every id to that shape (#4947).

// Each case runs the real Spectral CLI: 0.6 to 2.2 s on a busy 16-core machine,
// up to 20 s squeezed to a ninth of one core, well past bun's 5 s default.
// Sharing runs wouldn't shorten any one of them.
const LINT_TIMEOUT_MS = 60_000;

const lint = (
  operationId: string,
  schema: string,
  { command = ['bunx', 'spectral'], ruleset = '.spectral.yaml' } = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), 'spectral-'));
  try {
    const file = join(dir, 'spec.yaml');
    writeFileSync(
      file,
      `openapi: 3.1.0
info: { title: t, version: '1', description: d }
servers: [{ url: 'http://localhost' }]
paths:
  /x:
    get:
      operationId: ${operationId}
      security: []
      responses:
        '200':
          description: ok
components:
  schemas:
    ${schema}:
      type: object
`,
    );
    // -q keeps a "No results" line from following the JSON on a clean run.
    const p = Bun.spawnSync(
      [...command, 'lint', file, '-r', ruleset, '-f', 'json', '-q'],
      { cwd: join(import.meta.dir, '..') },
    );
    const stdout = p.stdout.toString();
    // 0 and 1 are verdicts, and each comes with JSON. A binary that can't
    // start also exits 1, but prints nothing.
    if ((p.exitCode !== 0 && p.exitCode !== 1) || !stdout) {
      throw new Error(
        `Spectral didn't run (exit ${p.exitCode}): ${p.stderr.toString()}`,
      );
    }
    const out = JSON.parse(stdout) as {
      code: string;
      severity: number;
      message: string;
    }[];
    return out.filter((r) => r.severity === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('spectral operationId shape', () => {
  test(
    'snake_case ids are rejected, with the reason',
    () => {
      const errors = lint(
        'verify_forgejo_instance',
        'VerifyForgejoInstanceResponse',
      );
      const hit = errors.find((r) => r.code === 'operation-id-camel-case');
      expect(hit).toBeDefined();
      expect(hit?.message).toContain('does not compile');
    },
    LINT_TIMEOUT_MS,
  );

  test(
    'a camelCase id passes the shape rule',
    () => {
      const errors = lint('verifyForgejoInstance', 'Other');
      expect(errors.map((r) => r.code)).not.toContain(
        'operation-id-camel-case',
      );
    },
    LINT_TIMEOUT_MS,
  );

  test(
    'a camelCase id still collides with its wrapper',
    () => {
      const errors = lint(
        'verifyForgejoInstance',
        'VerifyForgejoInstanceResponse',
      );
      expect(errors.map((r) => r.code)).toContain(
        'no-operation-wrapper-collision',
      );
    },
    LINT_TIMEOUT_MS,
  );
});

describe('spectral lint() helper', () => {
  test(
    'throws with stderr when the ruleset fails to load',
    () => {
      expect(() =>
        lint('ok', 'Other', { ruleset: 'no-such-ruleset.yaml' }),
      ).toThrow(/no-such-ruleset\.yaml/);
    },
    LINT_TIMEOUT_MS,
  );

  // A missing binary exits 1, the same status as a run that found errors.
  test('throws with stderr when Spectral fails to start', () => {
    const command = [
      process.execPath,
      '-e',
      'console.error("cannot start"); process.exit(1)',
    ];
    expect(() => lint('ok', 'Other', { command })).toThrow(/cannot start/);
  });

  // Output alone isn't a verdict: the exit status has to be one too.
  test('throws when Spectral prints results but exits 2', () => {
    const command = [
      process.execPath,
      '-e',
      'console.log("[]"); console.error("crashed"); process.exit(2)',
    ];
    expect(() => lint('ok', 'Other', { command })).toThrow(/crashed/);
  });

  test(
    'returns an empty list when there are no results at all',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'spectral-rules-'));
      try {
        const ruleset = join(dir, 'ruleset.yaml');
        writeFileSync(
          ruleset,
          "rules: { has-info: { given: '$', then: { field: info, function: truthy } } }\n",
        );
        expect(lint('ok', 'Other', { ruleset })).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    LINT_TIMEOUT_MS,
  );
});
