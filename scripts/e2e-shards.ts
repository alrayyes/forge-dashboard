import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..');
const testsDir = path.join(root, 'tests');
const durationsFile = path.join(testsDir, 'e2e-durations.json');

type Durations = Record<string, number>;

// Splits spec files over `total` shards so each shard's summed duration is
// close to the others': longest spec first, each into the lightest shard so
// far. A spec with no recorded duration counts as the average of the recorded
// ones, so a new spec lands somewhere sensible until the file is refreshed.
// Entries for specs that are gone are ignored. The result depends only on the
// inputs, never on the order specs arrive in.
export function assignShards(
  specs: string[],
  durations: Durations,
  total: number,
): string[][] {
  const known = specs.filter((s) => s in durations);
  const mean =
    known.length === 0
      ? 1
      : known.reduce((n, s) => n + durations[s], 0) / known.length;
  const weight = (s: string) => durations[s] ?? mean;
  const ordered = [...specs].sort(
    (a, b) => weight(b) - weight(a) || a.localeCompare(b),
  );
  const shards: string[][] = Array.from({ length: total }, () => []);
  const loads = new Array<number>(total).fill(0);
  for (const spec of ordered) {
    let lightest = 0;
    for (let i = 1; i < total; i++)
      if (loads[i] < loads[lightest]) lightest = i;
    shards[lightest].push(spec);
    loads[lightest] += weight(spec);
  }
  return shards.map((s) => s.sort());
}

// Seconds per spec file, summed from the testcase times of a JUnit report
// (`playwright merge-reports --reporter junit`).
export function durationsFromJunit(xml: string): Durations {
  const out: Durations = {};
  for (const m of xml.matchAll(
    /<testcase\b[^>]*?\bclassname="([^"]+)"[^>]*?\btime="([\d.]+)"/g,
  )) {
    out[m[1]] =
      Math.round((out[m[1]] ?? 0) * 1000 + Number(m[2]) * 1000) / 1000;
  }
  return out;
}

function listSpecs(): string[] {
  return readdirSync(testsDir)
    .filter((f) => f.endsWith('.spec.ts'))
    .sort();
}

function readDurations(): Durations {
  return JSON.parse(readFileSync(durationsFile, 'utf8')) as Durations;
}

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'shard' && a && b) {
    const index = Number(a);
    const total = Number(b);
    const shards = assignShards(listSpecs(), readDurations(), total);
    const mine = shards[index - 1];
    // `playwright test` with no file arguments runs every spec, so an empty
    // shard must fail rather than quietly run the whole suite.
    if (!mine || mine.length === 0) {
      console.error(`e2e shard ${index}/${total} has no specs`);
      process.exit(1);
    }
    console.log(mine.map((s) => `tests/${s}`).join('\n'));
  } else if (cmd === 'record' && a) {
    const fresh = durationsFromJunit(readFileSync(a, 'utf8'));
    const sorted = Object.fromEntries(
      Object.entries(fresh).sort(([x], [y]) => x.localeCompare(y)),
    );
    writeFileSync(durationsFile, `${JSON.stringify(sorted, null, 2)}\n`);
  } else if (cmd === 'plan' && a) {
    const total = Number(a);
    const durations = readDurations();
    assignShards(listSpecs(), durations, total).forEach((s, i) => {
      const sum = s.reduce((n, f) => n + (durations[f] ?? 0), 0);
      console.log(`shard ${i + 1}: ${s.length} specs, ${sum.toFixed(0)}s`);
    });
  } else {
    console.error(
      'usage: e2e-shards.ts shard <index> <total> | plan <total> | record <junit.xml>',
    );
    process.exit(2);
  }
}
