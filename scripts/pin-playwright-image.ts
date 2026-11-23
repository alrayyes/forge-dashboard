// Dependabot moves @playwright/test but can't edit the image pin the browser
// jobs carry, so scripts/test-playwright-image.sh fails until a person does
// (#4671). This is that edit, for a manual run: it reads the version from
// package.json, finds the tag's digest and rewrites every image line in the
// workflows. The pin-playwright-image workflow does the same with its own sed,
// so the job that holds the token runs no script from a pull request. Ported
// from movie-planner-web's scripts/pin-playwright-image.ts (its PR #989).

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'ghcr.io/alrayyes/ci-playwright';
// The `image:` lines scripts/test-playwright-image.sh reads, with or without a
// trailing comment.
const IMAGE =
  /^\s+image: (ghcr\.io\/alrayyes\/ci-playwright:\S+)[ \t]*(?:#.*)?$/gm;
// Any line that names the image, so one the pattern misses is an error and not
// a silent skip.
const MENTION = /^\s*image:.*ci-playwright:/gm;
// The guard fails below this many jobs on the image: the e2e shards,
// Lighthouse and the release screenshots.
const GUARD_MINIMUM = 3;

/** The exact @playwright/test version package.json pins, if it pins one. */
export function playwrightVersion(packageJson: string): string | undefined {
  return /"@playwright\/test":\s*"(\d+\.\d+\.\d+)"/.exec(packageJson)?.[1];
}

export function repinImage(
  workflow: string,
  version: string,
  digest: string,
): string {
  return workflow.replace(IMAGE, (line, image: string) =>
    line.replace(image, `${REPOSITORY}:${version}@${digest}`),
  );
}

export function digestFrom(imagetoolsOutput: string): string {
  const digest = /^Digest:\s*(sha256:[0-9a-f]{64})\s*$/m.exec(
    imagetoolsOutput,
  )?.[1];
  if (!digest) throw new Error('docker buildx imagetools printed no digest');
  return digest;
}

export type Repin = {
  packageJson: string;
  workflows: Record<string, string>;
  resolve: (version: string) => Promise<string>;
  /** Fewer image lines than this across the workflows is an error. */
  minimum?: number;
};

/** The workflows whose text changes, by file name. */
export async function repinWorkflows({
  packageJson,
  workflows,
  resolve,
  minimum = 0,
}: Repin): Promise<Record<string, string>> {
  const version = playwrightVersion(packageJson);
  if (!version) {
    throw new Error('package.json pins no exact @playwright/test version');
  }
  let found = 0;
  for (const [file, text] of Object.entries(workflows)) {
    const read = [...text.matchAll(IMAGE)].length;
    const named = [...text.matchAll(MENTION)].length;
    if (read !== named) {
      throw new Error(
        `${file} has ${named - read} ci-playwright image line(s) this script can't read`,
      );
    }
    found += read;
  }
  if (found < minimum) {
    throw new Error(
      `found ${found} image line(s) in the workflows, expected at least ${minimum}`,
    );
  }
  const digest = await resolve(version);
  const changed: Record<string, string> = {};
  for (const [file, text] of Object.entries(workflows)) {
    const next = repinImage(text, version, digest);
    if (next !== text) changed[file] = next;
  }
  return changed;
}

async function resolveWithDocker(version: string): Promise<string> {
  const image = `${REPOSITORY}:${version}`;
  const {
    stdout: out,
    stderr: err,
    status: code,
  } = spawnSync('docker', ['buildx', 'imagetools', 'inspect', image], {
    encoding: 'utf8',
  });
  if (code !== 0) {
    throw new Error(
      `${image} can't be read (${err.trim() || `exit ${code}`}). The ci-playwright repo ` +
        `has probably not built Playwright ${version} yet: wait for its build, then re-run this job.`,
    );
  }
  return digestFrom(out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(root, '.github', 'workflows');
  const workflows: Record<string, string> = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    workflows[file] = readFileSync(path.join(dir, file), 'utf8');
  }
  const changed = await repinWorkflows({
    packageJson: readFileSync(path.join(root, 'package.json'), 'utf8'),
    workflows,
    resolve: resolveWithDocker,
    minimum: GUARD_MINIMUM,
  });
  for (const [file, text] of Object.entries(changed)) {
    writeFileSync(path.join(dir, file), text);
    console.log(`repinned ${file}`);
  }
  if (Object.keys(changed).length === 0) {
    console.log('image pin already matches package.json');
  }
}
