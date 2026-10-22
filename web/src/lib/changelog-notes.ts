// Renders each changelog release's notes once. The page asks again whenever its
// state changes, and a release already asked for, whether it is still rendering
// or done, is not rendered a second time. A render that fails is forgotten and
// asked for again on a timer (RETRY_MS), since nothing else re-asks while the
// list stays the same. stop() cancels the timer when the page goes away.

// The leading "## [version](compare-link) (date)" line is dropped: the version
// and date are already shown above the notes. Only that first line goes. A
// "## " line further down is prose, and one inside a fenced code block is the
// block's text. A fence closes the way CommonMark says: on a fence of the same
// character, at least as long as the opener, with nothing after it.
export function withoutHeading(body: string | null): string {
  let fence: { char: string; length: number } | null = null;
  let leading = true;
  return (body || '')
    .split('\n')
    .filter((line) => {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          m &&
          m[1][0] === fence.char &&
          m[1].length >= fence.length &&
          m[2].trim() === ''
        ) {
          fence = null;
        }
        return true;
      }
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        fence = { char: m[1][0], length: m[1].length };
        leading = false;
        return true;
      }
      if (leading && line.trim() !== '') {
        leading = false;
        return !line.startsWith('## ');
      }
      return true;
    })
    .join('\n');
}

// The plain-text fallback for a card, stripped once per release instead of on
// every render of the page.
export function createPlainNotes(
  strip: (body: string) => string = withoutHeading,
): (release: { version: string; notes: string }) => string {
  const cache = new Map<string, string>();
  return (release) => {
    let text = cache.get(release.version);
    if (text === undefined) {
      text = strip(release.notes);
      cache.set(release.version, text);
    }
    return text;
  };
}

export const RETRY_MS = 5000;

// `done` gets the HTML, or null when the render failed.
export function createNoteRenderer(
  render: (text: string) => Promise<string>,
  done: (version: string, html: string | null) => void,
  retryMs: number = RETRY_MS,
): ((releases: { version: string; notes: string }[]) => Promise<boolean>) & {
  stop: () => void;
} {
  const started = new Map<string, Promise<boolean>>();
  let latest: { version: string; notes: string }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  // Resolves once every release in this call has been rendered or has failed:
  // true if all of them rendered, false if any failed or the renderer was
  // stopped. A caller holding cards back can tell a render from a failure.
  const request = (releases: { version: string; notes: string }[]) => {
    latest = releases;
    if (stopped) return Promise.resolve(false);
    const pending: Promise<boolean>[] = [];
    for (const r of releases) {
      const existing = started.get(r.version);
      if (existing) {
        pending.push(existing);
        continue;
      }
      const job = render(withoutHeading(r.notes)).then(
        (html) => {
          done(r.version, html);
          return true;
        },
        () => {
          started.delete(r.version);
          done(r.version, null);
          if (stopped || timer !== undefined) return false;
          timer = setTimeout(() => {
            timer = undefined;
            void request(latest);
          }, retryMs);
          return false;
        },
      );
      started.set(r.version, job);
      pending.push(job);
    }
    return Promise.all(pending).then((all) => all.every(Boolean));
  };
  request.stop = () => {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
  };
  return request;
}
