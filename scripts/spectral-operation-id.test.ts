/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The wrapper-collision rule uppercases an operationId's first letter, which
// matches oapi-codegen's PascalCase only while the id is camelCase
// alphanumeric. A rule holds every id to that shape (#4947).

const lint = (operationId: string, schema: string) => {
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
    const p = Bun.spawnSync(
      ['bunx', 'spectral', 'lint', file, '-r', '.spectral.yaml', '-f', 'json'],
      { cwd: join(import.meta.dir, '..') },
    );
    const out = JSON.parse(p.stdout.toString() || '[]') as {
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
  test('snake_case ids are rejected, with the reason', () => {
    const errors = lint(
      'verify_forgejo_instance',
      'VerifyForgejoInstanceResponse',
    );
    const hit = errors.find((r) => r.code === 'operation-id-camel-case');
    expect(hit).toBeDefined();
    expect(hit?.message).toContain('does not compile');
  });

  test('a camelCase id passes the shape rule', () => {
    const errors = lint('verifyForgejoInstance', 'Other');
    expect(errors.map((r) => r.code)).not.toContain('operation-id-camel-case');
  });

  test('a camelCase id still collides with its wrapper', () => {
    const errors = lint(
      'verifyForgejoInstance',
      'VerifyForgejoInstanceResponse',
    );
    expect(errors.map((r) => r.code)).toContain(
      'no-operation-wrapper-collision',
    );
  });
});
