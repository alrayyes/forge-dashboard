// Finds a mocked forge entry written by hand: an object literal that has both a
// `forge` key and a `reachable` or `repoCount` key at its own level (#4030). An
// entry that leaves `reachable` out still counts. Key order, other keys between
// them, a leading spread, quoted keys and shorthand all count.

import ts from 'typescript';

const key = (name: string) =>
  new RegExp(`(?:^|[{,\\s])(?:['"]${name}['"]|${name})\\s*(?::|(?=[,}\\s]|$))`);

const hasKey = (body: string, name: string) => {
  // Only the object's own level: a nested `{ ... }` has been blanked out.
  return key(name).test(body);
};

const blank = (text: string) => `"${' '.repeat(Math.max(0, text.length - 2))}"`;

// Strings, template text, regex literals and comments are text, not keys, unless
// a string is a quoted key. TypeScript's own parser says where each one starts
// and ends, so a quote in a regex or a comment cannot pair with another one
// (#4443). Everything else is left as written, so a template substitution that
// holds an entry is still read.
const withoutText = (raw: string) => {
  const file = ts.createSourceFile(
    'input.ts',
    raw,
    ts.ScriptTarget.Latest,
    true,
  );
  const edits = new Map<number, [number, string]>();
  const put = (start: number, end: number, text: string) =>
    edits.set(start, [end, text]);
  const comments = (pos: number) => {
    for (const list of [
      ts.getLeadingCommentRanges(raw, pos),
      ts.getTrailingCommentRanges(raw, pos),
    ]) {
      for (const c of list ?? []) {
        put(c.pos, c.end, raw.slice(c.pos, c.end).replace(/[^\n]/g, ' '));
      }
    }
  };
  const visit = (node: ts.Node) => {
    comments(node.getFullStart());
    comments(node.getEnd());
    const start = node.getStart(file);
    const end = node.getEnd();
    const text = raw.slice(start, end);
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral: {
        // A quoted key stays: a bare `{ 'forge': 1 }` fragment is a block, not an object.
        const isKey = /^\s*:/.test(raw.slice(end));
        if (!isKey) put(start, end, blank(text));
        break;
      }
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
      case ts.SyntaxKind.RegularExpressionLiteral:
        put(start, end, text.replace(/[^\n]/g, ' '));
        break;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  let out = '';
  let at = 0;
  for (const [start, [end, text]] of [...edits].sort((x, y) => x[0] - y[0])) {
    if (start < at) continue;
    out += raw.slice(at, start) + text;
    at = end;
  }
  return out + raw.slice(at);
};

export function writesForgeEntryByHand(raw: string): boolean {
  const source = withoutText(raw);
  const open: number[] = [];
  const spans: [number, number][] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '{') open.push(i);
    else if (source[i] === '}' && open.length > 0) {
      spans.push([open.pop() as number, i]);
    }
  }
  // An object's own level is its text with each nested `{ ... }` blanked out. A
  // nested one is taken whole, outermost first, so a block holding other blocks
  // is blanked once and none of its inside is left behind.
  spans.sort((x, y) => x[0] - y[0]);
  return spans.some(([start, end]) => {
    let body = '';
    let at = start;
    for (const [s, e] of spans) {
      if (s > start && e < end && s >= at) {
        body += `${source.slice(at, s)}{}`;
        at = e + 1;
      }
    }
    body += source.slice(at, end + 1);
    return (
      hasKey(body, 'forge') &&
      (hasKey(body, 'reachable') || hasKey(body, 'repoCount'))
    );
  });
}
