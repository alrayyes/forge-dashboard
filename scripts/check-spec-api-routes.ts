// A mock that names an unversioned /api/ route stops matching once the API
// lives under /api/v1, and the spec then hits the real server and times out.
// Fails when a spec under tests/ names such a route as a string, a glob or a
// regex (the slash may be escaped any number of times).
//
// What counts as a client route: "/api/<name>" preceded by something that is
// not part of a path (a quote, a backtick, a "*", a "}"), or by the
// authority of localhost, 127.0.0.1 or a single-label host such as
// http://h. A dotted host (forge.example/api/swagger) is a third party's
// URL, and internal/api/... is a repository path; neither is flagged.
//
// Allowed: /api/v1, /api/version and /api/webhooks (each must end at a
// boundary, so /api/version-x is flagged). A line that carries a
// `legacy-api-route` marker is exempt, for a deliberate test of a legacy
// alias; the marker covers its own line only. /api/nope, the 404 probe, is
// not allowed: it is used by Go tests, not by any spec.
// Run by `bun run lint:specs`, lefthook and the ci.yml js job.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULE =
  'Specs must name /api/v1/... routes. Only /api/version, ' +
  '/api/webhooks/... are unversioned; mark a deliberate ' +
  'legacy-route test with a `legacy-api-route` comment on its line.';

export interface Finding {
  line: number;
  text: string;
}

const SLASH = String.raw`\\*\/`;
const ROUTE = new RegExp(
  `(?:(?<![\\w.-])|(?<=:\\/\\/(?:localhost|127\\.0\\.0\\.1|[\\w-]+)(?::\\d+)?))` +
    `${SLASH}api${SLASH}(?!(?:v1|version|webhooks)(?![\\w-]))\\w`,
);

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
