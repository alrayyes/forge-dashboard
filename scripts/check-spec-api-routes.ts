// A mock that names an unversioned /api/ route stops matching once the API
// lives under /api/v1, and the spec then hits the real server and times out.
// Fails when a spec under tests/ names such a route as a string, a glob or a
// regex. Allowed: /api/v1, /api/version, /api/webhooks, /api/nope, and a line
// that carries a `legacy-api-route` marker (a deliberate test of a legacy
// alias). Run by `bun run lint:specs`, lefthook and the ci.yml js job.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULE =
  'Specs must name /api/v1/... routes. Only /api/version, ' +
  '/api/webhooks/... and /api/nope are unversioned; mark a deliberate ' +
  'legacy-route test with a `legacy-api-route` comment on its line.';

export interface Finding {
  line: number;
  text: string;
}

// "/api/" or its regex-escaped form "\/api\/", not preceded by a path
// character (so internal/api/ and host/api/ pass) and followed by a name.
const ROUTE =
  /(?<![\w.-])(?:\\\/|\/)api(?:\\\/|\/)(?!(?:v1|version|webhooks|nope)\b)[A-Za-z]/;

export function findUnversionedRoutes(source: string): Finding[] {
  const findings: Finding[] = [];
  source.split('\n').forEach((text, i) => {
    if (ROUTE.test(text) && !text.includes('legacy-api-route')) {
      findings.push({ line: i + 1, text: text.trim() });
    }
  });
  return findings;
}

function specFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return specFiles(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  let failed = false;
  for (const file of specFiles(path.join(root, 'tests'))) {
    for (const f of findUnversionedRoutes(readFileSync(file, 'utf8'))) {
      failed = true;
      console.error(`${path.relative(root, file)}:${f.line}: ${f.text}`);
    }
  }
  if (failed) {
    console.error(`\n${RULE}`);
    process.exit(1);
  }
}
