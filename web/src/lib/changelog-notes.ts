// Renders each changelog release's notes once. The page asks again whenever its
// state changes, and a release already asked for, whether it is still rendering
// or done, is not rendered a second time. A render that fails is forgotten, so
// the next ask tries it again once the network is back.

// The leading "## [version](compare-link) (date)" line is dropped: the version
// and date are already shown above the notes. A "## " line inside a fenced
// code block is the block's text, not a heading, and stays.
export function withoutHeading(body: string | null): string {
  let fence: string | null = null;
  return (body || '')
    .split('\n')
    .filter((line) => {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (m) {
        if (fence === null) fence = m[1][0];
        else if (m[1][0] === fence) fence = null;
      }
      return fence !== null || !line.startsWith('## ');
    })
    .join('\n');
}

// `done` gets the HTML, or null when the render failed.
export function createNoteRenderer(
  render: (text: string) => Promise<string>,
  done: (version: string, html: string | null) => void,
): (releases: { version: string; notes: string }[]) => void {
  const started = new Set<string>();
  return (releases) => {
    for (const r of releases) {
      if (started.has(r.version)) continue;
      started.add(r.version);
      render(withoutHeading(r.notes)).then(
        (html) => done(r.version, html),
        () => {
          started.delete(r.version);
          done(r.version, null);
        },
      );
    }
  };
}
