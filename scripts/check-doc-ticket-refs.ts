// Public docs carry no ticket references. A README, anything under docs/ and
// CONTRIBUTING.md get read away from the forge that holds the tracker (npm, a
// mirror, a search snippet), where a bare `#123` is plain text or links to the
// wrong repository, and where the forge itself is unreachable. The sentence
// that justified the ticket belongs there instead.
//
// Allowed: code (inline spans and fenced blocks, so message examples such as
// `Hid PR #123` stay legal) and a full https:// link to a third party's
// tracker. Run by the docs lint (`bun run lint:refs`, lefthook, ci.yml).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULE =
  'Public docs must say it in a sentence, not cite this repository’s own ' +
  'tickets: no #123, /issues/123, /pull/123 or git.higherlearning.eu ' +
  '(only a full https:// link to a third party’s tracker is allowed).';

export interface Finding {
  line: number;
  match: string;
}

// Blanks code out but keeps every newline, so line numbers stay true.
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

function stripCode(text: string): string {
  const lines = text.split('\n');
  let fence: string | null = null;
  const kept = lines.map((line) => {
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (open?.[1].startsWith(fence[0]) && open[1].length >= fence.length) {
        fence = null;
      }
      return blank(line);
    }
    if (open) {
      fence = open[1];
      return blank(line);
    }
    return line;
  });
  return kept.join('\n').replace(/(`+)[\s\S]*?\1/g, blank);
}

const OWN_URL = /alrayyes\/forge-dashboard|git\.higherlearning\.eu/i;
const URL = /https?:\/\/[^\s)>\]]+/g;
// A relative or own-repo tracker link, and the forge itself.
const TRACKER = /\/(?:issues|pull)\/\d+|git\.higherlearning\.eu/gi;
// #12 and owner/repo#12, but not a hex colour (#1a2b3c, #123456), a heading
// anchor (](#2-sec)), an entity (&#39;) or a six-digit run.
const BARE =
  /(?<![&\w])(?<!\]\()#\d{1,5}(?!\w)|[\w.-]+\/[\w.-]+#\d{1,5}(?!\w)/g;

export function findTicketRefs(markdown: string): Finding[] {
  // A third party's URL may end in #12 or /issues/12; it is a citation.
  const text = stripCode(markdown).replace(URL, (u) =>
    OWN_URL.test(u) ? u : blank(u),
  );
  const findings: Finding[] = [];
  for (const pattern of [TRACKER, BARE]) {
    for (const m of text.matchAll(pattern)) {
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ line, match: m[0] });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

function docFiles(root: string): string[] {
  const out = [
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'ARCHITECTURE.md',
  ];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(md|txt)$/.test(entry.name)) out.push(rel);
    }
  };
  walk('docs');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  let failed = false;
  for (const file of docFiles(root)) {
    let text: string;
    try {
      text = readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue; // a listed file this checkout lacks
    }
    for (const f of findTicketRefs(text)) {
      failed = true;
      console.error(`${file}:${f.line}: ${f.match}`);
    }
  }
  if (failed) {
    console.error(`\n${RULE}`);
    process.exit(1);
  }
}
