import { readdirSync } from 'node:fs';

// Mismatches between the specs under `dir` and the `**/name.spec.ts` entries
// in `patterns`: specs no entry names, and entries no spec matches (a renamed
// spec). Playwright runs only the listed specs, so an unlisted one would be
// skipped without a word; playwright.config.ts throws on either list instead.
export function unlistedSpecs(dir: string, patterns: string[]): string[] {
  const listed = new Set(patterns.map((p) => p.replace(/^\*\*\//, '')));
  const present = new Set(
    readdirSync(dir).filter((f) => f.endsWith('.spec.ts')),
  );
  const unlisted = [...present].filter((f) => !listed.has(f));
  const stale = [...listed].filter((f) => !present.has(f));
  return [...unlisted, ...stale].sort();
}
