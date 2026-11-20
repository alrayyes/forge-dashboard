// Finds a mocked forge entry written by hand: an object literal that has both a
// `forge` key and a `reachable` key at its own level (#4030). Key order, other
// keys between them, a leading spread, quoted keys and `{ forge, reachable }`
// shorthand all count.

const key = (name: string) =>
  new RegExp(`(?:^|[{,\\s])(?:['"]${name}['"]|${name})\\s*(?::|(?=[,}\\s]|$))`);

const hasKey = (body: string, name: string) => {
  // Only the object's own level: a nested `{ ... }` has been blanked out.
  return key(name).test(body);
};

// A one-line string literal is text, not keys, unless it is a quoted key.
const withoutStrings = (source: string) =>
  source.replace(/(['"`])(?:\\.|(?!\1)[^\n])*\1(\s*:)?/g, (text, _q, colon) =>
    colon ? text : '""',
  );

export function writesForgeEntryByHand(raw: string): boolean {
  const source = withoutStrings(raw);
  const open: number[] = [];
  const spans: [number, number][] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '{') open.push(i);
    else if (source[i] === '}' && open.length > 0) {
      spans.push([open.pop() as number, i]);
    }
  }
  return spans.some(([start, end]) => {
    let body = source.slice(start, end + 1);
    for (const [s, e] of spans) {
      if (s > start && e < end) {
        body = body.replace(source.slice(s, e + 1), '{}');
      }
    }
    return hasKey(body, 'forge') && hasKey(body, 'reachable');
  });
}
