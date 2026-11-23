/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  digestFrom,
  playwrightVersion,
  repinImage,
  repinWorkflows,
} from './pin-playwright-image';

// #4671: Dependabot moves @playwright/test but can't edit the image pin the
// browser jobs carry, so a workflow repins it. These cover the rewrite and the
// digest read; the last test runs the rewrite on the real workflows and counts
// the four references the guard, scripts/test-playwright-image.sh, reads.
const DIGEST = `sha256:${'c'.repeat(64)}`;
const OLD = `ghcr.io/alrayyes/ci-playwright:1.64.1@sha256:${'a'.repeat(64)}`;
const NEW = `ghcr.io/alrayyes/ci-playwright:1.65.1@${DIGEST}`;
const wf = (image: string) =>
  `jobs:\n  test:\n    container:\n      image: ${image}\n      options: --ipc=host --init\n`;

describe('playwrightVersion', () => {
  test('reads the exact pin', () => {
    expect(
      playwrightVersion(
        '{ "devDependencies": { "@playwright/test": "1.65.1" } }',
      ),
    ).toBe('1.65.1');
  });

  test('is undefined for a range or a missing pin', () => {
    expect(
      playwrightVersion('{ "@playwright/test": "^1.65.1" }'),
    ).toBeUndefined();
    expect(playwrightVersion('{}')).toBeUndefined();
  });
});

describe('repinImage', () => {
  test('moves the tag and digest, leaving the rest of the file alone', () => {
    expect(repinImage(wf(OLD), '1.65.1', DIGEST)).toBe(wf(NEW));
  });

  test('moves every image line in a file', () => {
    expect(repinImage(`${wf(OLD)}${wf(OLD)}`, '1.65.1', DIGEST)).toBe(
      `${wf(NEW)}${wf(NEW)}`,
    );
  });

  test('is a no-op when already pinned', () => {
    expect(repinImage(wf(NEW), '1.65.1', DIGEST)).toBe(wf(NEW));
  });

  test('leaves other images and a file with no image line untouched', () => {
    const other = wf('ubuntu:24.04');
    expect(repinImage(other, '1.65.1', DIGEST)).toBe(other);
    expect(repinImage('jobs: {}\n', '1.65.1', DIGEST)).toBe('jobs: {}\n');
  });
});

describe('digestFrom', () => {
  test('reads the index digest from imagetools output', () => {
    const out = `Name:      ghcr.io/alrayyes/ci-playwright:1.65.1\nMediaType: application/vnd.oci.image.index.v1+json\nDigest:    ${DIGEST}\n\nManifests:\n  Digest: sha256:${'d'.repeat(64)}\n`;
    expect(digestFrom(out)).toBe(DIGEST);
  });

  test('throws when there is no digest', () => {
    expect(() => digestFrom('nope')).toThrow('no digest');
  });
});

describe('repinWorkflows', () => {
  const packageJson = '{ "devDependencies": { "@playwright/test": "1.65.1" } }';

  test("asks for the package.json version's tag and rewrites each workflow", async () => {
    const asked: string[] = [];
    const out = await repinWorkflows({
      packageJson,
      workflows: { 'ci.yml': wf(OLD), 'lint.yml': 'jobs: {}\n' },
      resolve: async (version) => {
        asked.push(version);
        return DIGEST;
      },
    });
    expect(asked).toEqual(['1.65.1']);
    expect(out).toEqual({ 'ci.yml': wf(NEW) });
  });

  test('fails clearly when package.json pins no Playwright version', async () => {
    await expect(
      repinWorkflows({
        packageJson: '{}',
        workflows: {},
        resolve: async () => DIGEST,
      }),
    ).rejects.toThrow('pins no exact @playwright/test version');
  });

  test("passes on the resolver's failure, so a missing tag stops the job", async () => {
    await expect(
      repinWorkflows({
        packageJson,
        workflows: { 'ci.yml': wf(OLD) },
        resolve: async (v) => {
          throw new Error(`ci-playwright:${v} does not exist yet`);
        },
      }),
    ).rejects.toThrow('ci-playwright:1.65.1 does not exist yet');
  });

  test('repins all four image references in the real workflows', async () => {
    const dir = new URL('../.github/workflows/', import.meta.url).pathname;
    const workflows: Record<string, string> = {};
    for (const f of ['ci.yml', 'release.yml']) {
      workflows[f] = await Bun.file(dir + f).text();
    }
    const pkg = await Bun.file(
      new URL('../package.json', import.meta.url).pathname,
    ).text();
    const version = playwrightVersion(pkg);
    const out = await repinWorkflows({
      packageJson: pkg,
      workflows,
      resolve: async () => DIGEST,
    });
    const lines = Object.entries(workflows).flatMap(
      ([f, text]) =>
        (out[f] ?? text).match(
          /^\s+image: ghcr\.io\/alrayyes\/ci-playwright:\S+$/gm,
        ) ?? [],
    );
    expect(lines).toHaveLength(4);
    for (const l of lines) {
      expect(l.trim()).toBe(
        `image: ghcr.io/alrayyes/ci-playwright:${version}@${DIGEST}`,
      );
    }
  });
});
