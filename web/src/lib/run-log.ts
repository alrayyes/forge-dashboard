// Reading a check's output for the pipeline dialog, and copying it. No DOM here:
// the dialog says how to select text and which fetch to use.

// The kilobytes the server keeps of a long log. GET /api/checks/log cuts
// the start of a log past this.
const KEPT_KB = 256;

export type LogResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; message: string; signedOut?: boolean };

// The log endpoint for one job, from the checks url the board gave the dialog:
// it carries the forge and repository, so the boards need to say nothing more.
// Null when the url names no repository.
export function logUrl(checksUrl: string, jobId: number): string | null {
  const query = new URLSearchParams(checksUrl.split('?')[1] ?? '');
  const forge = query.get('forge');
  const fullName = query.get('fullName');
  if (!forge || !fullName) return null;

  return `/api/checks/log?${new URLSearchParams({ forge, fullName, jobId: String(jobId) })}`;
}

// What the dialog says above a log the server cut.
export function notePlaces(forgeName: string): string {
  return `Showing the last ${KEPT_KB} KB of this output. Open the run on ${forgeName} for the rest.`;
}

// Reads one job's output. A refusal is a sentence a person can use, never the
// forge's own words or an exception.
export async function loadRunLog(
  url: string,
  forgeName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LogResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);

    return { ok: false, message: `Couldn't load the output (${why}).` };
  }
  if (res.status === 401) {
    return {
      ok: false,
      signedOut: true,
      message: 'Your session ended. Sign in again.',
    };
  }
  if (res.ok) {
    const body = await res.json().catch(() => null);
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
