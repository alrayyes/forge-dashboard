import { readdirSync } from 'node:fs';

// Specs under `dir` that no `**/name.spec.ts` entry in `patterns` names.
// Playwright runs only the listed specs, so an unlisted one would be skipped
// without a word; playwright.config.ts throws on this list instead.
export function unlistedSpecs(dir: string, patterns: string[]): string[] {
  const listed = new Set(patterns.map((p) => p.replace(/^\*\*\//, '')));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.spec.ts') && !listed.has(f))
    .sort();
}
