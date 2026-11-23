// Dependabot moves @playwright/test but can't edit the image pin the browser
// jobs carry, so scripts/test-playwright-image.sh fails until a person does
// (#4671). This is that edit, run by the pin-playwright-image workflow: it
// reads the version from package.json, finds the tag's digest and rewrites
// every image line in the workflows. Ported from movie-planner-web's
// scripts/pin-playwright-image.ts (its PR #989).

const REPOSITORY = 'ghcr.io/alrayyes/ci-playwright';
// The same `image:` lines scripts/test-playwright-image.sh reads.
const IMAGE = /^\s+image: (ghcr\.io\/alrayyes\/ci-playwright:\S+)\s*$/gm;

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
};

/** The workflows whose text changes, by file name. */
export async function repinWorkflows({
  packageJson,
  workflows,
  resolve,
}: Repin): Promise<Record<string, string>> {
  const version = playwrightVersion(packageJson);
  if (!version) {
    throw new Error('package.json pins no exact @playwright/test version');
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
  const run = Bun.spawn(['docker', 'buildx', 'imagetools', 'inspect', image], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `${image} can't be read (${err.trim() || `exit ${code}`}). The ci-playwright repo ` +
        `has probably not built Playwright ${version} yet: wait for its build, then re-run this job.`,
    );
  }
  return digestFrom(out);
}

if (import.meta.main) {
  const root = new URL('..', import.meta.url).pathname;
  const dir = `${root}.github/workflows`;
  const workflows: Record<string, string> = {};
  for (const file of new Bun.Glob('*.yml').scanSync(dir)) {
    workflows[file] = await Bun.file(`${dir}/${file}`).text();
  }
  const changed = await repinWorkflows({
    packageJson: await Bun.file(`${root}package.json`).text(),
    workflows,
    resolve: resolveWithDocker,
  });
  for (const [file, text] of Object.entries(changed)) {
    await Bun.write(`${dir}/${file}`, text);
    console.log(`repinned ${file}`);
  }
  if (Object.keys(changed).length === 0) {
    console.log('image pin already matches package.json');
  }
}
