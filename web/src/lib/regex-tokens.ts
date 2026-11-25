// Splits an RE2 pattern into display tokens so the Ignored issue titles list
// can colour its structure (#4852). It only classifies characters; it never
// matches and never validates, so an invalid pattern still comes back whole.
// The server owns validation. Joining the tokens' text always gives the exact
// input, so copying and accessible names are unchanged.

export type RegexTokenKind =
  | 'anchor'
  | 'escape'
  | 'group'
  | 'class'
  | 'quantifier'
  | 'literal';

export interface RegexToken {
  kind: RegexTokenKind;
  text: string;
}

// \A \z \b \B match a position, so they read as anchors, not escapes.
const ANCHOR_ESCAPES = new Set(['A', 'z', 'b', 'B']);
const GROUP_OPEN = /^\(\?(?:P?<[A-Za-z0-9_]*>|[imsU-]*[:)]?)/;
const REPEAT = /^\{\d+(?:,\d*)?\}\??/;
const SIMPLE_REPEAT = /^[*+?]\??/;
const BRACED_ESCAPE = /^[xpP]\{[^}]*\}/;

// Length of the escape starting at s[0] === '\\', or 0 when it is a lone
// trailing backslash.
function escapeLength(s: string): number {
  if (s.length < 2) return 0;
  const braced = BRACED_ESCAPE.exec(s.slice(1));
  if (braced) return 1 + braced[0].length;
  if (s[1] === 'x' && /^[0-9A-Fa-f]{2}$/.test(s.slice(2, 4))) return 4;
  if ((s[1] === 'p' || s[1] === 'P') && s.length > 2) return 3;
  return 1 + String.fromCodePoint(s.codePointAt(1) ?? 0).length;
}

// Length of the class starting at s[0] === '[', or 0 when it never closes.
function classLength(s: string): number {
  let i = 1;
  if (s[i] === '^') i++;
  if (s[i] === ']') i++;
  while (i < s.length) {
    if (s[i] === '\\') i += 2;
    else if (s[i] === '[' && s[i + 1] === ':') {
      const end = s.indexOf(':]', i + 2);
      i = end < 0 ? i + 1 : end + 2;
    } else if (s[i] === ']') return i + 1;
    else i++;
  }
  return 0;
}

export function tokenizeRegex(pattern: string): RegexToken[] {
  const tokens: RegexToken[] = [];
  const push = (kind: RegexTokenKind, text: string) => {
    const last = tokens[tokens.length - 1];
    if (kind === 'literal' && last?.kind === 'literal') last.text += text;
    else tokens.push({ kind, text });
  };

  let i = 0;
  while (i < pattern.length) {
    const rest = pattern.slice(i);
    const c = rest[0];
    if (c === '\\') {
      const n = escapeLength(rest);
      if (n === 0) {
        push('literal', rest);
        break;
      }
      push(ANCHOR_ESCAPES.has(rest[1]) ? 'anchor' : 'escape', rest.slice(0, n));
      i += n;
    } else if (c === '^' || c === '$') {
      push('anchor', c);
      i++;
    } else if (c === '(') {
      const open = GROUP_OPEN.exec(rest);
      const text = open ? open[0] : '(';
      push('group', text);
      i += text.length;
    } else if (c === ')' || c === '|') {
      push('group', c);
      i++;
    } else if (c === '[') {
      const n = classLength(rest);
      if (n === 0) {
        push('literal', rest);
        break;
      }
      push('class', rest.slice(0, n));
      i += n;
    } else if (c === '.') {
      push('class', c);
      i++;
    } else {
      const repeat = SIMPLE_REPEAT.exec(rest) ?? REPEAT.exec(rest);
      const text = repeat
        ? repeat[0]
        : String.fromCodePoint(rest.codePointAt(0) ?? 0);
      push(repeat ? 'quantifier' : 'literal', text);
      i += text.length;
    }
  }
  return tokens;
}
