import type { Page, Route } from '@playwright/test';
import { installFakeStream, pushNamedStream } from './fake-stream-helper';

// The job lists of an open pipeline dialog arrive as "run" events on the
// dashboard stream, one for each workflow run attempt, after the page posts
// which subjects it watches. This stands in for the server's side of that: it
// answers the watch and sends a list for each subject the page newly watches,
// and again when the watch asks for a refresh. A spec changes what a subject
// answers by pushing a list itself (pushChecks), as the server does when the
// row's CI moves.

export type CheckRow = {
  name: string;
  status: string;
  conclusion?: string;
  url: string;
  [key: string]: unknown;
};

export type Subject = {
  kind: 'pull_request' | 'main_branch';
  forge: string;
  fullName: string;
  number?: number;
};

// A list, or why there is none.
export type Reply = unknown[] | { error: string };

type Serve = (subject: Subject, call: number) => Reply | Promise<Reply>;

const keyOf = (s: Subject) =>
  `${s.kind}|${s.forge}|${s.fullName}|${s.number ?? 0}`;

// The key the server gives a unit of a list: a run attempt, or a check that
// belongs to no run.
function groupKey(c: CheckRow) {
  const runId = Number(c.runId ?? 0);
  return runId > 0
    ? `run/${runId}/${Number(c.runAttempt ?? 0)}`
    : `job/${c.url}|${c.name}`;
}

// The keys last sent for each subject on each page, so the next list can say
// which runs are gone.
const sent = new WeakMap<Page, Map<string, string[]>>();

function events(page: Page, subject: Subject, reply: Reply) {
  if (!Array.isArray(reply)) {
    return [{ ...subject, error: reply.error }] as Record<string, unknown>[];
  }
  const groups = new Map<string, CheckRow[]>();
  for (const c of reply as CheckRow[]) {
    const key = groupKey(c);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const before = sent.get(page) ?? new Map<string, string[]>();
  sent.set(page, before);
  const out: Record<string, unknown>[] = [...groups].map(([key, checks]) => ({
    ...subject,
    key,
    runId: checks[0].runId,
    runAttempt: checks[0].runAttempt,
    checks,
  }));
  for (const key of before.get(keyOf(subject)) ?? []) {
    if (!groups.has(key)) out.push({ ...subject, key, gone: true });
  }
  before.set(keyOf(subject), [...groups.keys()]);
  if (out.length === 0) out.push({ ...subject });
  out[out.length - 1].final = true;
  return out;
}

// Sends the page a subject's list, or its failure, as the server would.
export async function pushChecks(page: Page, subject: Subject, reply: Reply) {
  for (const ev of events(page, subject, reply)) {
    await pushNamedStream(page, 'run', ev);
  }
}

// Answers the page's watch posts. `serve` is asked for each subject the page
// starts watching, and for every subject again on a refresh; `call` counts
// the asks for that subject from 1. `asked` lists the subjects asked for, in
// order, and `idle` resolves once every answer has been sent.
export async function serveChecks(page: Page, serve: Serve) {
  await installFakeStream(page);
  let watched = new Set<string>();
  let stream = '';
  const asked: Subject[] = [];
  const calls = new Map<string, number>();
  const inflight = new Set<Promise<void>>();
  await page.route('**/api/dashboard/stream/watch', async (route: Route) => {
    const body = route.request().postDataJSON() as {
      streamId: string;
      subjects: Subject[];
      refresh?: boolean;
    };
    // The server forgets a watch with its stream, so a reloaded page, which
    // opens a new one, is listed everything again.
    if (body.streamId !== stream) {
      stream = body.streamId;
      watched = new Set();
    }
    const before = watched;
    watched = new Set(body.subjects.map(keyOf));
    const due = body.subjects.filter(
      (subject) => body.refresh || !before.has(keyOf(subject)),
    );
    await route.fulfill({ status: 204 });
    const work = (async () => {
      for (const subject of due) {
        const key = keyOf(subject);
        const call = (calls.get(key) ?? 0) + 1;
        calls.set(key, call);
        asked.push(subject);
        const reply = await serve(subject, call);
        // A test can end with an answer still on its way; the page is gone,
        // so there is nobody to tell.
        if (page.isClosed()) return;
        await pushChecks(page, subject, reply).catch((err: Error) => {
          if (!page.isClosed()) throw err;
        });
      }
    })();
    inflight.add(work);
    await work;
    inflight.delete(work);
  });

  return {
    asked,
    idle: async () => {
      await Promise.all([...inflight]);
    },
  };
}
