import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assignShards, durationsFromJunit, speedsFor } from './e2e-shards';

test('every spec lands in exactly one shard', () => {
  const durations = { 'a.spec.ts': 5, 'b.spec.ts': 3, 'c.spec.ts': 2 };
  const shards = assignShards(Object.keys(durations), durations, 2);
  expect(shards.flat().sort()).toEqual(['a.spec.ts', 'b.spec.ts', 'c.spec.ts']);
});

test('the longest specs go to different shards and the rest even them out', () => {
  const durations = {
    'a.spec.ts': 10,
    'b.spec.ts': 9,
    'c.spec.ts': 5,
    'd.spec.ts': 5,
    'e.spec.ts': 1,
  };
  const shards = assignShards(Object.keys(durations), durations, 2);
  const totals = shards.map((s) =>
    s.reduce((n, f) => n + durations[f as keyof typeof durations], 0),
  );
  expect(Math.abs(totals[0] - totals[1])).toBeLessThanOrEqual(1);
});

test('a slower shard is given proportionally less work', () => {
  const durations = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`s${i}.spec.ts`, 10]),
  );
  const shards = assignShards(Object.keys(durations), durations, 2, [0.5, 1]);
  expect(shards[0].length).toBe(13);
  expect(shards[1].length).toBe(27);
});

test('a spec with no recorded duration counts as the average of the rest', () => {
  const durations = { 'a.spec.ts': 10, 'b.spec.ts': 10 };
  const specs = ['a.spec.ts', 'b.spec.ts', 'new.spec.ts'];
  const shards = assignShards(specs, durations, 3);
  expect(shards.every((s) => s.length === 1)).toBe(true);
});

test('the assignment is the same on every call, whatever order specs arrive in', () => {
  const durations = { 'a.spec.ts': 4, 'b.spec.ts': 4, 'c.spec.ts': 4 };
  const one = assignShards(
    ['a.spec.ts', 'b.spec.ts', 'c.spec.ts'],
    durations,
    2,
  );
  const two = assignShards(
    ['c.spec.ts', 'a.spec.ts', 'b.spec.ts'],
    durations,
    2,
  );
  expect(two).toEqual(one);
});

test('a durations entry for a spec that no longer exists is ignored', () => {
  const shards = assignShards(
    ['a.spec.ts'],
    { 'a.spec.ts': 1, 'gone.spec.ts': 99 },
    2,
  );
  expect(shards.flat()).toEqual(['a.spec.ts']);
});

test('durations sum the test times of each spec in a JUnit report', () => {
  const xml = `<testsuites>
<testsuite name="a.spec.ts" tests="2">
<testcase name="x" classname="a.spec.ts" time="1.5"></testcase>
<testcase name="y" classname="a.spec.ts" time="2.25"></testcase>
</testsuite>
<testsuite name="b.spec.ts" tests="1">
<testcase name="z" classname="b.spec.ts" time="0.5"></testcase>
</testsuite>
</testsuites>`;
  expect(durationsFromJunit(xml)).toEqual({
    'a.spec.ts': 3.75,
    'b.spec.ts': 0.5,
  });
});

// The committed split, not the algorithm: a durations file that falls behind
// the suite leaves one shard carrying the specs it doesn't know about, and that
// shard hits the job's 10 minute limit (#3477). CONTRIBUTING.md says how to
// refresh it.
const specDir = path.join(import.meta.dir, '..', 'tests');
const committed = JSON.parse(
  readFileSync(path.join(specDir, 'e2e-durations.json'), 'utf8'),
) as Record<string, number>;
const specs = readdirSync(specDir)
  .filter((f) => f.endsWith('.spec.ts'))
  .sort();

// A spec missing from the file counts as the average one, and a suite that grew
// by a few big specs then skews one shard. 5 percent of the specs went missing
// before shards 2 and 6 ran 2m40 over the fastest (#3477), so the bound is 3.
test('the committed durations cover at least 97 percent of the specs', () => {
  const missing = specs.filter((s) => !(s in committed));
  expect(missing.length / specs.length).toBeLessThanOrEqual(0.03);
});

test('a ci.yml without the shard list says what is missing', () => {
  expect(() => shardCount('jobs: {}')).toThrow('no shard list in ci.yml');
});

function shardCount(yml: string): number {
  const list = /echo 'list=(\[[\d,]+\])'/.exec(yml)?.[1];
  if (!list) {
    throw new Error(
      "no shard list in ci.yml: expected an `echo 'list=[1,2,...]'` line; fix it or this pattern",
    );
  }
  return (JSON.parse(list) as number[]).length;
}

// The count CI runs, read from the one place it lives.
const ciYml = readFileSync(
  path.join(import.meta.dir, '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);
const ciShards = shardCount(ciYml);

function predictedLoads(): number[] {
  const known = specs.filter((s) => s in committed);
  const mean = known.reduce((n, s) => n + committed[s], 0) / known.length;
  const speeds = speedsFor(ciShards);
  return assignShards(specs, committed, ciShards, speeds).map(
    (shard, i) =>
      shard.reduce((n, s) => n + (committed[s] ?? mean), 0) / speeds[i],
  );
}

test("the committed durations split the suite over CI's shards within 30 seconds", () => {
  const loads = predictedLoads();
  expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(30);
});

// A balanced split isn't enough. About a quarter of runners run the same specs
// a third slower than the rest, and setup adds about a minute, so 300 seconds
// of recorded work is a job of about 7m40 on a slow one, right at the 7.5
// minute line (#3477). Over that, add a shard in ci.yml. Nine shards also pass
// this today (293 seconds), so running ten rests on the measured job times, not
// on this test.
test('no shard CI runs is given more than 300 seconds of work', () => {
  expect(Math.max(...predictedLoads())).toBeLessThanOrEqual(300);
});
