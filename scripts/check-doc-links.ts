// A README or docs move must not leave a dead link behind. This reads the
// Markdown people read (README.md, CONTRIBUTING.md, ARCHITECTURE.md,
// SECURITY.md and everything under docs/) and fails on:
//   - a relative or /root-relative link or image whose file is missing
//     (matched case-sensitively, as GitHub serves it), and
//   - a `file.md#heading` or `#heading` whose heading does not exist, using
//     GitHub's slug rules (lowercase, punctuation dropped, spaces to hyphens,
//     repeated headings suffixed -1, -2).
// External links (http, https, mailto) are never fetched: a flaky network must
// not fail a build. Links inside code are ignored. CHANGELOG.md is written by
// release-please and is not scanned. Run by `bun run lint:links`, lefthook and
// ci.yml; its test is check-doc-links.test.ts.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Finding {
  file: string;
  line: number;
  target: string;
  reason: string;
}

const ROOT_PAGES = [
  'README.md',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
  'SECURITY.md',
];

// Blanks text out but keeps every newline, so line numbers stay true.
const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

// Fenced blocks and HTML comments blanked; inline code is left alone.
function stripFences(text: string): string {
  let fence: string | null = null;
  const kept = text.split('\n').map((line) => {
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
  return kept.join('\n').replace(/<!--[\s\S]*?-->/g, blank);
}

// Fences, comments and inline code all blanked: what links are read from.
function stripCode(text: string): string {
  return stripFences(text).replace(/(`+)[\s\S]*?\1/g, blank);
}

// GitHub's heading anchor: strip inline markup, lowercase, drop everything but
// letters, digits, underscores, hyphens and spaces, then spaces to hyphens.
export function slug(heading: string): string {
  // Code keeps its text, underscores included; emphasis is rendered away
  // first, so _emph_ and *emph* lose their markers but snake_case does not.
  const keep = '\uE000';
  const plain = heading
    .replace(/(`+)([\s\S]*?)\1/g, (_, __, code: string) =>
      code.trim().replace(/_/g, keep),
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\*+|~~/g, '')
    .replace(/(^|[^\p{L}\p{N}_])_+(?=[\p{L}\p{N}])/gu, '$1')
    .replace(/(?<=[\p{L}\p{N}])_+(?=[^\p{L}\p{N}_]|$)/gu, '');
  return plain
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- \uE000]/gu, '')
    .replace(/ /g, '-')
    .replaceAll(keep, '_');
}

function anchorsOf(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  const text = stripFences(markdown);
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    const h = line.match(/^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/);
    let title = h ? (h[1] ?? '') : null;
    // Setext: a paragraph line underlined by === or ---.
    const prev = lines[i - 1] ?? '';
    if (
      title === null &&
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(line) &&
      /\S/.test(prev) &&
      !/^ {0,3}(?:#{1,6}(?:\s|$)|>|[-*+]\s|\d+[.)]\s|(?:=+|-+)\s*$)/.test(prev)
    ) {
      title = prev.trim();
    }
    if (title === null) continue;
    const base = slug(title);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of text.matchAll(/<a\s[^>]*\b(?:id|name)="([^"]+)"/gi)) {
    anchors.add(m[1].toLowerCase());
  }
  return anchors;
}

interface Link {
  line: number;
  dest: string;
}

function linksOf(markdown: string): Link[] {
  const text = stripCode(markdown);
  const out: Link[] = [];
  const add = (index: number, dest: string) =>
    out.push({ line: text.slice(0, index).split('\n').length, dest });
  // [text](dest "title") and ![alt](dest); matching on `](` finds the inner
  // image of [![alt](img)](url) as well as the outer link.
  for (const m of text.matchAll(
    /\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
  )) {
    add(m.index, m[1].replace(/^<|>$/g, ''));
  }
  for (const m of text.matchAll(/^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>]*>|\S+)/gm)) {
    add(m.index, m[1].replace(/^<|>$/g, ''));
  }
  for (const m of text.matchAll(/<[a-z][^>]*?\b(?:href|src)="([^"]+)"/gi)) {
    add(m.index, m[1]);
  }
  return out.filter((l) => l.dest !== '');
}

// existsSync is case-insensitive on some filesystems, so confirm each
// segment against the directory listing.
function existsExact(root: string, rel: string): boolean {
  let dir = root;
  for (const part of rel.split('/').filter((p) => p && p !== '.')) {
    if (!readdirSync(dir).includes(part)) return false;
    dir = path.join(dir, part);
  }
  return existsSync(dir);
}

function markdownFiles(root: string): string[] {
  const out = ROOT_PAGES.filter((f) => existsSync(path.join(root, f)));
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) out.push(rel);
    }
  };
  if (existsSync(path.join(root, 'docs'))) walk('docs');
  return out;
}

const read = (root: string, rel: string): string =>
  readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '');

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function checkDocLinks(root: string): Finding[] {
  const findings: Finding[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = (rel: string, markdown?: string) => {
    let a = anchorCache.get(rel);
    if (!a) {
      a = anchorsOf(markdown ?? read(root, rel));
      anchorCache.set(rel, a);
    }
    return a;
  };

  for (const file of markdownFiles(root)) {
    const markdown = read(root, file);
    for (const { line, dest } of linksOf(markdown)) {
      if (EXTERNAL.test(dest)) continue;
      const [beforeHash, ...frag] = dest.split('#');
      const fragment = frag.join('#');
      const pathPart = beforeHash.split('?')[0];
      let target: string;
      try {
        target = decodeURIComponent(pathPart);
      } catch {
        target = pathPart;
      }
      const problem = (reason: string) =>
        findings.push({ file, line, target: dest, reason });

      let rel = file;
      if (target !== '') {
        rel = target.startsWith('/')
          ? path.posix.normalize(target.slice(1))
          : path.posix.normalize(
              path.posix.join(path.posix.dirname(file), target),
            );
        // ../../security/advisories/new climbs out of the repo: it is a
        // forge URL (GitHub resolves it against the web path), not a file.
        if (rel === '..' || rel.startsWith('../')) continue;
        if (!existsExact(root, rel)) {
          problem('file not found');
          continue;
        }
      }
      if (fragment === '' || !rel.endsWith('.md')) continue;
      if (statSync(path.join(root, rel)).isDirectory()) continue;
      const wanted = decodeURIComponent(fragment).toLowerCase();
      const have = anchorsFor(rel, rel === file ? markdown : undefined);
      if (!have.has(wanted)) problem('heading not found');
    }
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root =
    process.argv[2] ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const findings = checkDocLinks(root);
  for (const f of findings) {
    console.error(`${f.file}:${f.line}: ${f.target} (${f.reason})`);
  }
  if (findings.length > 0) {
    console.error(
      '\nA relative link, image or #anchor in the docs points at nothing. ' +
        'Fix the link, or restore the file or heading it names.',
    );
    process.exit(1);
  }
}
