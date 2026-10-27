// Reading a check's output for the pipeline dialog, and copying it. No DOM here:
// the dialog says how to select text and which fetch to use.

// The kilobytes the server keeps of a long log. GET /api/checks/log cuts
// the start of a log past this.
const KEPT_KB = 256;

// How long a read for Copy log may take, answer and body, before it counts as
// failed. Without a bound a stalled read would leave a copy waiting for good.
// View run sets none: it shows its own loading state and can be closed.
const COPY_LOG_TIMEOUT_MS = 30_000;

// How long a log read for Copy log is reused before it is read again. The
// server waits a while after a job finishes because a read just then can miss
// lines the runner hasn't flushed; a press in that window mustn't pin a short
// log for the life of the row.
export const COPIED_LOG_KEPT_MS = 60_000;

export type LogResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; message: string; signedOut?: boolean };

// The repository a dialog's checks belong to: where a job's log is read from.
export type RepoRef = { forge: string; fullName: string };

// The log endpoint for one job of repo. Null when no repository is named.
export function logUrl(
  repo: RepoRef | undefined,
  jobId: number,
): string | null {
  if (!repo?.forge || !repo.fullName) return null;
  const { forge, fullName } = repo;

  return `/api/checks/log?${new URLSearchParams({ forge, fullName, jobId: String(jobId) })}`;
}

// What the dialog says above a log the server cut.
export function notePlaces(forgeName: string): string {
  return `Showing the last ${KEPT_KB} KB of this output. Open the run on ${forgeName} for the rest.`;
}

// Reads one job's output. A refusal is a sentence a person can use, never the
// forge's own words or an exception. A read has no time limit unless
// `timeoutMs` is given.
export async function loadRunLog(
  url: string,
  forgeName: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<LogResult> {
  const signal =
    timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  try {
    return await readRunLog(url, forgeName, fetchImpl, signal);
  } catch (err) {
    const why =
      err instanceof Error && err.name === 'TimeoutError'
        ? 'the forge took too long to answer'
        : err instanceof Error
          ? err.message
          : String(err);

    return { ok: false, message: `Couldn't load the output (${why}).` };
  }
}

async function readRunLog(
  url: string,
  forgeName: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<LogResult> {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (res.status === 401) {
    return {
      ok: false,
      signedOut: true,
      message: 'Your session ended. Sign in again.',
    };
  }
  if (res.ok) {
    const body = await res.json().catch((err) => {
      // A body cut off by the timeout is a stalled read, not a bad answer.
      if (signal?.aborted) throw err;

      return null;
    });
    if (typeof body?.text === 'string') {
      return { ok: true, text: body.text, truncated: body.truncated === true };
    }

    return { ok: false, message: "Couldn't read the answer for this output." };
  }
  switch (res.status) {
    case 403:
      return {
        ok: false,
        message: `The saved ${forgeName} token can't read this job's output. Open the run on ${forgeName} instead.`,
      };
    case 404:
      return {
        ok: false,
        message: `${forgeName} has no output for this job. It may have expired, or this check isn't a job that keeps one.`,
      };
    case 429:
      return {
        ok: false,
        message: `${forgeName} is limiting requests right now. Wait a moment and try again.`,
      };
    default:
      return {
        ok: false,
        message: `Couldn't load the output: ${forgeName} didn't answer (${res.status}).`,
      };
  }
}

export type CopyDeps = {
  clipboard?: { writeText(text: string): Promise<void> };
  // Copies what is selected on the page; true when the browser did it. The
  // caller selects the text first, so a refusal leaves it ready to copy by hand.
  select(): boolean;
};

// Copies the whole output. The async clipboard needs a secure context and a
// permission; where it is missing or refuses, the selection copy is tried, and
// failing that the text is left selected for the person to copy.
export async function copyLog(
  text: string,
  deps: CopyDeps,
): Promise<'copied' | 'selected'> {
  if (deps.clipboard) {
    try {
      await deps.clipboard.writeText(text);

      return 'copied';
    } catch {
      // fall through to the selection copy
    }
  }

  return deps.select() ? 'copied' : 'selected';
}

// Where a check's full log is read from, and why there is no address when
// there is none: no job to read, or a dialog that names no repository.
export function logSource(
  repo: RepoRef | undefined,
  jobId: number | undefined,
): { url: string | null; why?: string } {
  if (!jobId) return { url: null };
  const url = logUrl(repo, jobId);

  return url
    ? { url }
    : {
        url: null,
        why: "Couldn't tell which repository this check belongs to.",
      };
}

// Whether a check has a log worth a Copy log button: a failure or timeout
// (a cancelled run is not a failure to debug) that carries an excerpt, or that
// has a job whose log the repository can name. No
// repository gives no log address, so a job alone isn't enough.
export function canCopyLog(
  check: { state: string; excerpt?: string; jobId?: number },
  repo: RepoRef | undefined,
): boolean {
  if (check.state !== 'failure' && check.state !== 'timed_out') return false;
  if (check.excerpt) return true;

  return !!check.jobId && !!logUrl(repo, check.jobId);
}

// What a check offers beside its name: nothing, the forge's own page, the
// output panel, or a plain link. A queued job has no log yet, so only the
// forge's page. So does a running GitHub job, whose log GitHub serves only
// once the job finishes. A skipped job never ran; a job with no page has
// nowhere to go. A held workflow's own page is where the forge's approve
// button is. Only a job with an id, a page and a repository can open the
// output panel.
export type CheckControl = 'none' | 'open-on-forge' | 'output' | 'link';

// The accessible name of a check link that opens the forge in a new tab. It
// starts with the visible text so the name still holds the words on screen
// (WCAG 2.5.3).
export function checkLinkLabel(text: string, check: string): string {
  return `${text} (opens in a new tab): ${check}`;
}

// Whether a running job's output can't be read yet: only Forgejo serves a
// running job's log, and GitHub answers 404 until the job finishes. A checks
// address that names no forge counts as not Forgejo.
function runningWithoutLog(state: string, repo: RepoRef | undefined): boolean {
  return state === 'running' && !!repo && repo.forge !== 'forgejo';
}

export function checkControl(
  check: { state: string; url?: string; jobId?: number },
  repo: RepoRef | undefined,
): CheckControl {
  if (!check.url) return 'none';
  if (check.state === 'queued') return 'open-on-forge';
  if (check.state === 'skipped') return 'none';
  if (runningWithoutLog(check.state, repo)) return 'open-on-forge';
  if (check.state !== 'awaiting_approval' && check.jobId && repo) {
    return 'output';
  }

  return 'link';
}

// The words on the link a check offers beside its name. A running job that
// links out has no output to show until it finishes, and says that it is
// watched on the forge; a queued one has not started, and is only opened.
export function checkLinkText(
  control: CheckControl,
  state: string,
  forgeName: string,
): string {
  if (control === 'open-on-forge') {
    return `${state === 'running' ? 'Watch' : 'Open'} on ${forgeName}`;
  }

  return state === 'awaiting_approval' ? 'Approve on GitHub' : 'View run';
}

// What a failed check's Copy button puts on the clipboard: the whole log when
// the log endpoint answers, else the excerpt the list already carries. `kind`
// says which landed ("cut" is a whole log the server trimmed to its last
// KEPT_KB), and `why` says in words why only the excerpt did, when it is that.
export type Prepared = {
  text: string;
  kind: 'whole' | 'cut' | 'excerpt';
  why: string;
};

export async function logToCopy(
  url: string | null,
  excerpt: string,
  forgeName: string,
  fetchImpl: typeof fetch = fetch,
  noUrlWhy = 'This check has no job to read a full log from.',
): Promise<Prepared> {
  if (!url) return { text: excerpt, kind: 'excerpt', why: noUrlWhy };
  const got = await loadRunLog(url, forgeName, fetchImpl, COPY_LOG_TIMEOUT_MS);
  // A signed-out answer is not about the log: copy nothing, so the clipboard
  // keeps what it held, and say to sign in.
  if (!got.ok && got.signedOut) {
    return { text: '', kind: 'excerpt', why: got.message };
  }
  if (got.ok && got.text) {
    return { text: got.text, kind: got.truncated ? 'cut' : 'whole', why: '' };
  }
  if (got.ok) {
    return { text: excerpt, kind: 'excerpt', why: 'The job wrote no output.' };
  }

  return { text: excerpt, kind: 'excerpt', why: got.message };
}

// The sentence a copy earns, true to what is on the clipboard (or not).
export function copyStatus(
  outcome: CopyOutcome,
  prepared: Prepared,
  forgeName: string,
  // What was copied, for the sentences that name it.
  noun = 'log',
): string {
  const only = prepared.kind === 'excerpt';
  const lost = only ? ` ${prepared.why}` : '';
  if (outcome === 'nothing') return `Nothing was copied.${lost}`;
  if (outcome === 'selected') {
    const press = 'press Ctrl+C (Cmd+C on a Mac) to copy it';
    if (only) {
      return `Couldn't copy automatically. The excerpt is selected below: ${press}.${lost}`;
    }
    const cut =
      prepared.kind === 'cut'
        ? ` It is the last ${KEPT_KB} KB of the ${noun}, which is all the dashboard keeps. Open the run on ${forgeName} for the rest.`
        : '';

    return `Couldn't copy automatically. The ${noun} is selected below: ${press}.${cut}`;
  }
  if (only) return `Copied the excerpt only.${lost}`;
  if (prepared.kind === 'cut') {
    return `Copied the last ${KEPT_KB} KB of the ${noun}, which is all the dashboard keeps. Open the run on ${forgeName} for the rest.`;
  }

  return 'Copied';
}

// 'nothing' is a copy that had no text to put on the clipboard; it never
// touches the clipboard.
export type CopyOutcome = 'copied' | 'selected' | 'nothing';

export type PendingCopyDeps = {
  clipboard?: {
    writeText(text: string): Promise<void>;
    write?(items: unknown[]): Promise<void>;
  };
  // A clipboard item whose text is still being read, so the write starts inside
  // the click and the browser waits for the text (Safari drops a write that
  // comes after an awaited fetch).
  makeItem?: (text: Promise<string>) => unknown;
  // Copies `text` through the page selection; true when the browser did it.
  select(text: string): boolean;
};

// Copies what `pending` resolves to. The clipboard write is handed the promise
// first; where that is missing or refused, the same text is copied once known.
// That second try runs after the read, outside the click's user activation, so
// a browser that needs the activation may refuse it and leave the text selected.
export async function copyPending(
  pending: Promise<Prepared>,
  deps: PendingCopyDeps,
): Promise<{ outcome: CopyOutcome; prepared: Prepared }> {
  if (deps.clipboard?.write && deps.makeItem) {
    try {
      // An empty answer rejects the item, so the write fails and the clipboard
      // keeps what it held.
      const text = pending.then((p) => {
        if (!p.text) throw new Error('nothing to copy');

        return p.text;
      });
      // If makeItem or write throws before anything awaits `text`, its
      // rejection would go unhandled; the fallback below reads `pending` itself.
      text.catch(() => {});
      await deps.clipboard.write([deps.makeItem(text)]);

      return { outcome: 'copied', prepared: await pending };
    } catch {
      // fall through to the plain copy of the same text
    }
  }
  const prepared = await pending;
  if (!prepared.text) return { outcome: 'nothing', prepared };
  const outcome = await copyLog(prepared.text, {
    clipboard: deps.clipboard,
    select: () => deps.select(prepared.text),
  });

  return { outcome, prepared };
}
