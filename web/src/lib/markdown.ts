// Renders the Markdown a forge hands back (a pull request description, a
// comment, release notes) to HTML that is safe to insert. The server doesn't
// sanitise it (#1506), so the safety lives here:
//   - raw HTML is escaped as text, except the allow-listed tags below, which
//     markdown-it parses (`html: true`, narrowed by rules further down) and
//     which are rebuilt as tokens (#4241). A Dependabot description is HTML
//     inside Markdown. Only `details`, `summary`, `p`, `br`, `ul`, `ol`,
//     `li`, `blockquote`, `code`, `pre`, `em`, `strong`, `a` (its `href`) and
//     `h1`-`h6` count, and every attribute but that `href` is dropped. The
//     author's markup is never echoed: a tag that doesn't match one strict
//     pattern is text, an unclosed tag is closed with its container and a
//     stray closer is dropped. `a` goes through the link rules below, and an
//     `<img>` is not a tag at all, so images stay on the proxy;
//   - its default link validator refuses javascript:, vbscript: and data:
//     links, which stay as plain text;
//   - an image loads only when the caller's `imageSource` maps its address to
//     the server's proxy (#3405). Any other image shows as a link or as its
//     alt text, so no <img> loads from a stranger's URL and no tracking pixel
//     fires on open;
//   - an HTML comment (`<!-- ... -->`, the bookkeeping bots such as Renovate
//     leave in a description) is dropped by two parser rules, never a regex
//     over the source, so a code span or fenced block keeps its text. Nothing
//     of the comment reaches the output, and `html` stays off (#3668);
//   - task list items (`- [x] done`) become read-only checkboxes: a disabled
//     <input type="checkbox"> inside a <label> with the item's text, built
//     from the parsed tokens, so the text stays escaped (#1655);
//   - every link opens in a new tab with rel="noopener noreferrer";
//   - `#12` and `owner/repo#12` in plain text link to the item on the same
//     forge when the caller says which repository the text belongs to, and a
//     full item address on that forge (bare or a link target) is the same
//     reference (#4230);
//   - :shortcodes: such as :robot: become the Unicode emoji, the way the
//     forges draw them (#1995). Never an image, and the plugin skips code.
//     Emoticons like `:)` stay as typed: the forges don't expand them and
//     they would rewrite ordinary text.
// Not covered by the allow-list (#4292). It stops script, handlers, styles,
// forms, frames, remote images and dangerous link schemes. It does not stop
// an author looking like something else:
//   - a link that names one address and goes to another, which a Markdown
//     link could always do;
//   - text in a heading or `summary` that looks like a status or approval;
//   - a fake blockquote or fake command: `<blockquote>` and `<code>` styled
//     as the forge's own quote or a `@dependabot` command, to be copied;
//   - content in a collapsed `details`;
//   - output size: each unclosed `<a href="...">` is closed and gets
//     `target` and `rel`, so a body of them renders about four times larger.
// The library is imported on first use, so the dashboard's own chunk doesn't
// carry it.
import type MarkdownIt from 'markdown-it';
import type { ImageSource } from './image-source';

type Renderer = InstanceType<typeof MarkdownIt>;
type StateInline = Parameters<
  Parameters<Renderer['inline']['ruler']['push']>[1]
>[0];
type StateBlock = Parameters<
  Parameters<Renderer['block']['ruler']['push']>[1]
>[0];
type StateCore = Parameters<
  Parameters<Renderer['core']['ruler']['push']>[1]
>[0];

let renderer: Promise<Renderer> | null = null;

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
// CommonMark also reads `<!-->` and `<!--->` as (empty) comments, so the
// closing marker is searched for from just after `<!`.
const COMMENT_SEARCH_FROM = 2;

// Where `-->` is searched for, per parse, so a document of unclosed openers
// costs one scan, not one per opener. The value is the first position after
// which a search found nothing.
const noCloseFrom = new WeakMap<object, Map<string, number>>();
// Closers that made a block comment fail, so the openers before them skip
// the line scan too.
const failedClose = new WeakMap<object, Set<string>>();

function findClose(env: unknown, src: string, from: number): number {
  const key = typeof env === 'object' && env !== null ? env : null;
  let seen: Map<string, number> | undefined;
  if (key) {
    seen = noCloseFrom.get(key) ?? new Map<string, number>();
    noCloseFrom.set(key, seen);
    const known = seen.get(src);
    if (known !== undefined && from >= known) return -1;
  }
  const end = src.indexOf(COMMENT_CLOSE, from);
  if (end === -1 && seen) {
    seen.set(src, Math.min(seen.get(src) ?? from, from));
  }
  return end;
}

// An inline `<!-- ... -->`, on one line or several inside one paragraph: it
// advances past the comment and emits no token. Code spans are matched by
// their own rule at their own backtick, so a comment inside one never gets
// here. An unclosed comment stays text.
function commentInline(state: StateInline): boolean {
  if (!state.src.startsWith(COMMENT_OPEN, state.pos)) return false;
  const end = findClose(state.env, state.src, state.pos + COMMENT_SEARCH_FROM);
  if (end === -1) return false;
  state.pos = end + COMMENT_CLOSE.length;
  return true;
}

// The last line whose start is at or before `pos` (bMarks only grows).
function lineAt(state: StateBlock, pos: number, endLine: number): number {
  let lo = 0;
  let hi = endLine - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (state.bMarks[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// A comment that opens a line and closes on a later one, possibly across
// blank lines (which would otherwise split it into paragraphs). A comment
// that closes on its first line is left to the inline rule, since text may
// follow it. Text after the closing `-->` leaves it to the inline rule too.
// Indented code and fences never reach this rule.
function commentBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const lineStart = state.bMarks[startLine] + state.tShift[startLine];
  if (!state.src.startsWith(COMMENT_OPEN, lineStart)) return false;
  const close = findClose(
    state.env,
    state.src,
    lineStart + COMMENT_SEARCH_FROM,
  );
  if (close === -1) return false;
  const closeLine = lineAt(state, close, endLine);
  if (closeLine <= startLine) return false;
  const failKey = `${close}:${state.blkIndent}`;
  const failed = failedClose.get(state) ?? new Set<string>();
  failedClose.set(state, failed);
  if (failed.has(failKey)) return false;
  const fail = () => {
    failed.add(failKey);
    return false;
  };
  const after = state.src.slice(
    close + COMMENT_CLOSE.length,
    state.eMarks[closeLine],
  );
  if (after.trim() !== '') return fail();
  for (let line = startLine + 1; line <= closeLine; line++) {
    if (!state.isEmpty(line) && state.sCount[line] < state.blkIndent) {
      return fail();
    }
  }
  if (!silent) state.line = closeLine + 1;
  return true;
}

// Text that is nothing once the comments are gone.
const blank = (c: { type: string; content: string }) =>
  c.type === 'softbreak' ||
  c.type === 'hardbreak' ||
  (c.type === 'text' && c.content.trim() === '');

// A paragraph or heading that held only comments is empty once they're gone:
// drop it, so no empty <p> or <h1> is drawn.
function dropEmptyBlocks(state: StateCore): void {
  const { tokens } = state;
  for (let i = tokens.length - 3; i >= 0; i--) {
    const open = tokens[i].type;
    if (open !== 'paragraph_open' && open !== 'heading_open') continue;
    const inline = tokens[i + 1];
    if (
      inline.type === 'inline' &&
      tokens[i + 2].type === open.replace('_open', '_close') &&
      (inline.children ?? []).every(blank)
    ) {
      tokens.splice(i, 3);
    }
  }
}

const TASK = /^\[([ xX])\](?=\s)\s*/;

// GFM task list items: only a list item whose first paragraph starts with
// `[ ]` or `[x]` and a space (`- [x]` then a newline is a task in GFM but
// stays literal here: a rare form, left out on purpose). markdown-it parses
// code spans, link labels and mid-sentence text as their own tokens, so none
// of those match.
function taskLists(state: StateCore): void {
  const { tokens, Token } = state;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (
      inline.type !== 'inline' ||
      tokens[i - 1].type !== 'paragraph_open' ||
      tokens[i - 2].type !== 'list_item_open'
    ) {
      continue;
    }
    const first = inline.children?.[0];
    const m = first?.type === 'text' ? TASK.exec(first.content) : null;
    if (!first || !inline.children || !m) continue;
    first.content = first.content.slice(m[0].length);
    inline.content = inline.content.slice(m[0].length);
    const open = new Token('html_inline', '', 0);
    open.content = `<label class="task"><input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
    const close = new Token('html_inline', '', 0);
    close.content = '</label>';
    inline.children = [open, ...inline.children, close];
    tokens[i - 2].attrJoin('class', 'task-list-item');
  }
}

// `#12` and `owner/repo#12` in running text, the forms both forges autolink:
// https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls
// The lookbehind keeps `abc#12`, `a/b/c#12` and `&#12` as text, and the
// lookahead keeps `#12abc` as text.
// The owner is the characters either forge allows in one (Forgejo adds `_`
// and `.` to GitHub's letters, digits and hyphen), and a repository of only
// digits is read as a fraction (`1/2#3`), not a repository. A mention
// (`@user/team#5`) is left to the forge. `and/or#3` still links: telling it
// from a real repository would take a lookup the page can't make.
/**
 * Which references open a dialog on the dashboard: the forge the text came
 * from, and whether a repository (`owner/name`) is one the dashboard tracks.
 */
export type ReferenceOptions = {
  forge: string;
  tracked: (repo: string) => boolean;
};

// A full item address on the forge the text came from, as a link target:
// `/owner/repo/pull/12`, `/issues/12` or Forgejo's `/pulls/12`, with no query,
// fragment (`#issuecomment-1`) or further path (`/files`).
const ITEM_ADDRESS =
  /^\/([A-Za-z0-9][\w.-]*\/[\w.-]+)\/(?:pulls?|issues)\/(\d{1,9})\/?$/;

// An item of a repository the dashboard does not track stays a forge link,
// which a modified click and a failed lookup still use. These attributes let
// a plain click try the item's dialog first (#4269).
function markUntracked(
  link: { attrSet: (name: string, value: string) => void },
  repo: string,
  n: string,
  url: string,
): void {
  link.attrSet('data-ref-repo', repo);
  link.attrSet('data-ref-number', n);
  link.attrSet('data-ref-url', url);
  link.attrSet('data-ref-untracked', '');
}

function itemOf(
  href: string,
  host: string,
): { repo: string; n: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.origin !== host || url.search || url.hash) return null;
  const m = ITEM_ADDRESS.exec(url.pathname);
  if (!m) return null;
  // `/issues/05` is item 5 on both forges, so the number is read as one.
  // There is no item 0, so `/issues/0` and `/issues/00` stay forge links.
  const n = Number(m[2]);
  return n > 0 ? { repo: m[1], n: String(n) } : null;
}

const REFERENCE =
  /(?<![\w/&#.@-])([A-Za-z0-9][\w.-]*\/(?!\d+#)[\w.-]+)?#(\d+)(?![\w-])/g;

// Turns references into links to the item on the same forge. Only plain
// text tokens are touched: code spans and blocks are other token types, and
// text inside a link (an explicit one or a linkified URL) is skipped.
// Without a repository address the text stays as it is.
function references(state: StateCore): void {
  const env = state.env as
    | { repoUrl?: string; dashboardRefs?: ReferenceOptions }
    | undefined;
  const repoUrl = env?.repoUrl;
  if (!repoUrl) return;
  const url = new URL(repoUrl);
  const host = url.origin;
  const ownRepo = url.pathname.replace(/^\/+|\/+$/g, '');
  const dashboard = env?.dashboardRefs;
  const { Token } = state;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const out: typeof block.children = [];
    let inLink = 0;
    let swapClose = false;
    for (const child of block.children) {
      if (child.type === 'link_open') {
        const item = dashboard
          ? itemOf(String(child.attrGet('href') ?? ''), host)
          : null;
        if (
          dashboard &&
          item &&
          /^[a-z]+$/.test(dashboard.forge) &&
          dashboard.tracked(item.repo)
        ) {
          // An item address is the same reference as `#N`: same in-app link,
          // the visible text untouched.
          const open = new Token('html_inline', '', 0);
          open.content = `<a href="/issues.html?issue=${dashboard.forge}/${item.repo}/${item.n}" data-ref-repo="${item.repo}" data-ref-number="${item.n}" data-ref-url="${host}/${item.repo}/issues/${item.n}">`;
          out.push(open);
          swapClose = true;
          inLink++;
          continue;
        }
        // An item of a repository the dashboard does not track goes to the
        // forge, and says so like an untracked `#N` does. A click first tries
        // the dialog and falls back to this address (#4269).
        if (dashboard && item) {
          child.meta = { opensOnForge: true };
          markUntracked(
            child,
            item.repo,
            item.n,
            String(child.attrGet('href')),
          );
        }
        inLink++;
      }
      if (child.type === 'link_close') {
        inLink--;
        if (swapClose) {
          swapClose = false;
          const close = new Token('html_inline', '', 0);
          close.content = '</a>';
          out.push(close);
          continue;
        }
      }
      if (child.type !== 'text' || inLink > 0) {
        out.push(child);
        continue;
      }
      let last = 0;
      for (const m of child.content.matchAll(REFERENCE)) {
        // There is no item 0, and `/issues/0` is no reference either (itemOf):
        // `#0` and `#00` stay plain text.
        if (Number(m[2]) === 0) continue;
        const text = new Token('text', '', 0);
        text.content = child.content.slice(last, m.index);
        const repo = m[1] || ownRepo;
        const forgeUrl = `${host}/${repo}/issues/${m[2]}`;
        if (
          dashboard &&
          /^[a-z]+$/.test(dashboard.forge) &&
          dashboard.tracked(repo)
        ) {
          // The dashboard opens it in place; the address keeps middle-click
          // and copy-link working. Built here, not as a link token: the link
          // rule below turns an address that is not absolute http(s) into
          // text. Every part is a number or the characters REFERENCE allows.
          const link = new Token('html_inline', '', 0);
          link.content = `<a href="/issues.html?issue=${dashboard.forge}/${repo}/${m[2]}" data-ref-repo="${repo}" data-ref-number="${m[2]}" data-ref-url="${forgeUrl}">${m[0]}</a>`;
          out.push(text, link);
        } else {
          // Nothing to open here: a repository the dashboard does not track
          // goes to the forge, and says so.
          const open = new Token('link_open', 'a', 1);
          open.attrSet('href', forgeUrl);
          if (dashboard) markUntracked(open, repo, m[2], forgeUrl);
          const label = new Token('text', '', 0);
          label.content = m[0];
          const note = new Token('html_inline', '', 0);
          note.content =
            '<span class="sr-only"> (opens on the forge in a new tab)</span>';
          const close = new Token('link_close', 'a', -1);
          out.push(text, open, label, note, close);
        }
        last = m.index + m[0].length;
      }
      if (last === 0) {
        out.push(child);
      } else {
        const rest = new Token('text', '', 0);
        rest.content = child.content.slice(last);
        out.push(rest);
      }
    }
    block.children = out;
  }
}

// --- Allow-listed raw HTML (#4241) -------------------------------------------
//
// The tags a block may open or close, and those that may sit inside a line.
const BLOCK_TAGS = new Set([
  'details',
  'summary',
  'p',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);
const INLINE_TAGS = new Set(['a', 'br', 'code', 'em', 'strong']);
// Only these may stay open across a blank line, because Markdown sits inside
// them (a Dependabot `<details>` holds paragraphs and lists). Any other tag
// ends with its own HTML block, so it can't wrap what follows. All of them
// end with their markdown container.
const SPANNING_TAGS = new Set(['details', 'blockquote', 'ul', 'ol', 'li']);
// A deeper stack is shown as text, so nesting can't be used to build a tower.
const MAX_RAW_DEPTH = 16;
// A tag longer than this is text, which also bounds the work per `<`.
const MAX_TAG_LENGTH = 4096;

// One tag: a name and attributes, each a plain name with an optional quoted
// or bare value. `<a/onclick=x>`, `<a x=">` and the like don't match and stay
// text. A closing tag takes no attributes.
const TAG =
  /^<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>$/;
const ATTRIBUTE =
  /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const BLOCK_START =
  /^<\/?(?:details|summary|p|ul|ol|li|blockquote|pre|h[1-6])(?=[\s/>]|$)/i;

type RawTag = { closing: boolean; name: string; href: string | null };
type Tok = InstanceType<StateCore['Token']>;

function parseTag(source: string, names: Set<string>): RawTag | null {
  if (source.length > MAX_TAG_LENGTH) return null;
  const m = TAG.exec(source);
  if (!m) return null;
  const name = m[2].toLowerCase();
  if (!names.has(name)) return null;
  const closing = m[1] === '/';
  if (closing && (m[3] !== '' || m[4] !== '')) return null;
  let href: string | null = null;
  if (name === 'a' && !closing) {
    for (const attr of m[3].matchAll(ATTRIBUTE)) {
      if (attr[1].toLowerCase() !== 'href') continue;
      href ??= attr[2] ?? attr[3] ?? attr[4] ?? '';
    }
  }
  return { closing, name, href };
}

// The token for a tag. `markup` marks it as raw so the balancing pass knows
// it from the parser's own; `content` keeps the source for the fallback.
function rawToken(
  Token: StateCore['Token'],
  tag: RawTag,
  source: string,
  decode: (s: string) => string,
): Tok {
  const link = tag.name === 'a';
  let type = tag.closing ? 'raw_close' : 'raw_open';
  if (link) type = tag.closing ? 'link_close' : 'link_open';
  if (tag.name === 'br') type = 'raw_br';
  const token = new Token(
    type,
    tag.name,
    tag.name === 'br' ? 0 : tag.closing ? -1 : 1,
  );
  token.markup = 'raw';
  token.content = source;
  if (link && !tag.closing && tag.href !== null) {
    token.attrs = [['href', decode(tag.href)]];
  }
  if (tag.name === 'pre' && !tag.closing) token.attrs = [['tabindex', '0']];
  return token;
}

const isRaw = (t: { markup: string }) => t.markup === 'raw';

// Entities stay as written (they decode to text, never to a tag); a bare `&`
// and the characters of a tag are escaped.
function escapeRawText(text: string): string {
  return text.replace(
    /&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});)|[<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

// A block of raw HTML as tokens: text, allow-listed tags and nothing else.
// Comments are dropped; any other `<` is text.
function blockTokens(
  content: string,
  Token: StateCore['Token'],
  decode: (s: string) => string,
): Tok[] {
  const out: Tok[] = [];
  const names = new Set([...BLOCK_TAGS, ...INLINE_TAGS]);
  let text = '';
  let noClose = false;
  const flush = () => {
    if (text === '') return;
    const t = new Token('raw_text', '', 0);
    t.content = text;
    out.push(t);
    text = '';
  };
  let i = 0;
  while (i < content.length) {
    const lt = content.indexOf('<', i);
    if (lt === -1) {
      text += content.slice(i);
      break;
    }
    text += content.slice(i, lt);
    i = lt + 1;
    if (content.startsWith('<!--', lt) && !noClose) {
      const close = content.indexOf(COMMENT_CLOSE, lt + COMMENT_SEARCH_FROM);
      if (close !== -1) {
        i = close + COMMENT_CLOSE.length;
        continue;
      }
      noClose = true;
    }
    const gt = content.slice(lt, lt + MAX_TAG_LENGTH).indexOf('>');
    const source = gt === -1 ? '' : content.slice(lt, lt + gt + 1);
    const tag = source === '' ? null : parseTag(source, names);
    if (!tag) {
      text += '<';
      continue;
    }
    flush();
    out.push(rawToken(Token, tag, source, decode));
    i = lt + source.length;
  }
  flush();
  return out;
}

// Opens and closes what the author opened. A markdown container (list item,
// quote) closing closes the raw tags opened inside it. A tag that may not
// span blocks closes where its HTML block ends (a boundary token), and one
// in a line of text where the line ends. A closer with no opener is dropped,
// and a link never nests in a link.
function balance(
  tokens: Tok[],
  Token: StateCore['Token'],
  insideLink: boolean,
): Tok[] {
  const out: Tok[] = [];
  const open: { name: string; level: number }[] = [];
  let level = 0;
  let links = insideLink ? 1 : 0;
  const closeTop = () => {
    const e = open.pop();
    if (!e) return;
    const link = e.name === 'a';
    const t = new Token(link ? 'link_close' : 'raw_close', e.name, -1);
    t.markup = 'raw';
    out.push(t);
    if (link) links--;
  };
  for (const t of tokens) {
    if (t.type === 'raw_boundary') {
      // The end of an HTML block: close every tag that may not span blocks,
      // and what was opened inside it, in this container.
      let first = -1;
      for (let i = open.length - 1; i >= 0 && open[i].level === level; i--) {
        if (!SPANNING_TAGS.has(open[i].name)) first = i;
      }
      while (first !== -1 && open.length > first) closeTop();
      continue;
    }
    if (isRaw(t) && t.nesting === 1) {
      if (open.length >= MAX_RAW_DEPTH) {
        const text = new Token('text', '', 0);
        text.content = t.content;
        out.push(text);
        continue;
      }
      if (t.tag === 'a') {
        if (links > 0) t.attrs = null;
        links++;
      }
      open.push({ name: t.tag, level });
      out.push(t);
    } else if (isRaw(t) && t.nesting === -1) {
      let at = open.length - 1;
      while (at >= 0 && open[at].level === level && open[at].name !== t.tag) {
        at--;
      }
      if (at < 0 || open[at].level !== level) continue;
      while (open.length > at + 1) closeTop();
      open.pop();
      if (t.tag === 'a') links--;
      out.push(t);
    } else if (t.nesting === -1) {
      while (open.length > 0 && open[open.length - 1].level === level) {
        closeTop();
      }
      level--;
      if (t.type === 'link_close') links--;
      out.push(t);
    } else if (t.nesting === 1) {
      level++;
      if (t.type === 'link_open') {
        if (links > 0) t.attrs = null;
        links++;
      }
      out.push(t);
    } else {
      if (t.type === 'inline' && t.children) {
        t.children = balance(t.children, Token, links > 0);
      }
      out.push(t);
    }
  }
  while (open.length > 0) closeTop();
  return out;
}

// Core rule: raw HTML blocks become tokens, then every token stream is
// balanced.
function rawHtml(decode: (s: string) => string) {
  return (state: StateCore): void => {
    const tokens: Tok[] = [];
    for (const t of state.tokens) {
      if (t.type === 'html_block') {
        tokens.push(...blockTokens(t.content, state.Token, decode));
        const end = new state.Token('raw_boundary', '', 0);
        end.markup = 'raw';
        tokens.push(end);
      } else {
        tokens.push(t);
      }
    }
    state.tokens = balance(tokens, state.Token, false);
  };
}

// An allow-listed tag in a line of text. Anything else is left to the text
// rule, so it is shown as typed.
function rawInline(decode: (s: string) => string) {
  return (state: StateInline, silent: boolean): boolean => {
    const { src, pos } = state;
    if (src.charCodeAt(pos) !== 0x3c) return false;
    const window = src.slice(pos, pos + MAX_TAG_LENGTH);
    const gt = window.indexOf('>');
    if (gt === -1) return false;
    const source = window.slice(0, gt + 1);
    const tag = parseTag(source, INLINE_TAGS);
    if (!tag) return false;
    if (!silent) {
      // Pushed flat: the balancing pass owns the nesting, and the parser's
      // own depth counter must not drift on an unclosed run of them.
      state.pushPending();
      state.tokens.push(rawToken(state.Token, tag, source, decode));
    }
    state.pos = pos + source.length;
    return true;
  };
}

// markdown-it ends a `<pre` block at the first line holding `</pre>` in its
// container, else at the end of the container: an unclosed one would take all
// the rest. So a `<pre` is a block only when that closer comes before a code
// fence or another `<pre`, which a closer further on would otherwise swallow.
// The cost is a pre that holds a line starting with a fence, or one indented
// 4+ spaces that looks like one, shown as text (still contained).
const PRE_OPEN = /^<pre(?=[\s>])/i;
const PRE_CLOSE = /<\/pre>/i;
const FENCE_OPEN = /^(?:`{3}|~{3})/;

function preCloses(state: StateBlock, start: number, end: number): boolean {
  for (let line = start; line < end; line++) {
    const from = state.bMarks[line] + state.tShift[line];
    const text = state.src.slice(from, state.eMarks[line]);
    if (PRE_CLOSE.test(text)) return true;
    if (line > start && (FENCE_OPEN.test(text) || PRE_OPEN.test(text))) {
      return false;
    }
  }
  return false;
}

// An HTML block only starts at an allow-listed block tag; markdown-it's own
// rule does the rest (where it ends, what a comment or blank line does).
function narrowHtmlBlock(md: Renderer): void {
  const rule = md.block.ruler.__rules__.find((r) => r.name === 'html_block');
  if (!rule) throw new Error('markdown-it has no html_block rule');
  const original = rule.fn;
  md.block.ruler.at(
    'html_block',
    (state: StateBlock, start: number, end: number, silent: boolean) => {
      const pos = state.bMarks[start] + state.tShift[start];
      if (!BLOCK_START.test(state.src.slice(pos, pos + 16))) return false;
      if (PRE_OPEN.test(state.src.slice(pos, pos + 5))) {
        if (!preCloses(state, start, end)) return false;
      }
      return original(state, start, end, silent);
    },
    { alt: ['paragraph', 'reference', 'blockquote'] },
  );
}

const MONO_LABEL = /^(#\d+|[0-9a-f]{7,40})$/;

function create(
  MarkdownItCtor: typeof MarkdownIt,
  emoji: (
    md: Renderer,
    options?: { shortcuts?: Record<string, never> },
  ) => void,
): Renderer {
  // `html: true` only lets markdown-it's HTML block rule run; it is narrowed
  // to the allow-list, its inline rule is replaced and its tokens rebuilt.
  const md = new MarkdownItCtor({ html: true, linkify: true });
  emoji(md, { shortcuts: {} });
  const decode = (value: string) => md.utils.unescapeAll(value);
  narrowHtmlBlock(md);
  md.inline.ruler.disable('html_inline');
  md.inline.ruler.before('html_inline', 'raw-html-inline', rawInline(decode));
  md.block.ruler.before('paragraph', 'html-comment', commentBlock);
  md.inline.ruler.before('autolink', 'html-comment', commentInline);
  md.core.ruler.after('inline', 'drop-empty-blocks', dropEmptyBlocks);
  md.core.ruler.after('inline', 'task-lists', taskLists);
  md.core.ruler.after('linkify', 'references', references);
  // Registered last of the rules after `inline`, so it runs first.
  md.core.ruler.after('inline', 'raw-html', rawHtml(decode));
  // The core rule replaces every html_block token, so this never runs; it
  // stays so that a token that got past it is shown as text, not as HTML.
  md.renderer.rules.html_block = (tokens, idx) =>
    md.utils.escapeHtml(tokens[idx].content);
  md.renderer.rules.raw_text = (tokens, idx) =>
    escapeRawText(tokens[idx].content);
  // A code block can scroll sideways, and a keyboard can only scroll what
  // takes focus.
  for (const rule of ['fence', 'code_block'] as const) {
    const base = md.renderer.rules[rule];
    if (!base) continue;
    md.renderer.rules[rule] = (...args) =>
      base(...args).replace('<pre', '<pre tabindex="0"');
  }
  md.renderer.rules.image = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    const src = String(token.attrGet('src') ?? '');
    const alt = token.children
      ? md.renderer.renderInlineAsText(token.children, md.options, env)
      : token.content;
    const esc = md.utils.escapeHtml;
    const imageSource = (env as { imageSource?: ImageSource } | undefined)
      ?.imageSource;
    let inLink = 0;
    for (const t of tokens.slice(0, idx)) {
      if (t.type === 'link_open') inLink++;
      if (t.type === 'link_close') inLink--;
    }
    const proxy = imageSource?.(src) ?? null;
    if (!proxy) {
      // Never loaded: a link to it where a link may go, else its text.
      const label = esc(alt || src);
      return inLink === 0 && /^https?:/i.test(src)
        ? `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
    }
    const img = `<img src="${esc(proxy)}" alt="${esc(alt)}" class="md-image" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    // A decorative image (no alt) or one already in a link gets no link of
    // its own: an empty link has no name for a screen reader.
    return alt && inLink === 0
      ? `<a href="${esc(proxy)}" target="_blank" rel="noopener noreferrer">${img}</a>`
      : img;
  };
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = String(tokens[idx].attrGet('href') ?? '');
    // Only absolute http(s) and mailto links are links. A relative or
    // protocol-relative href would resolve against the dashboard's own
    // origin, so it stays as plain text instead.
    if (!/^(https?:|mailto:)/i.test(href)) {
      tokens[idx].tag = 'span';
      tokens[idx].attrs = null;
      // Its own closer is the one at the same depth.
      let depth = 1;
      for (let i = idx + 1; i < tokens.length; i++) {
        if (tokens[i].type === 'link_open') depth++;
        if (tokens[i].type === 'link_close' && --depth === 0) {
          tokens[i].tag = 'span';
          break;
        }
      }
      return self.renderToken(tokens, idx, options);
    }
    // Release notes ask for it: a link labelled `#123` or a commit hash is a
    // reference, not prose, so it gets the mono class. The label is matched,
    // never the surrounding text.
    if (
      (env as { monoReferences?: boolean } | undefined)?.monoReferences &&
      MONO_LABEL.test(tokens[idx + 1]?.content ?? '')
    ) {
      tokens[idx].attrSet('class', 'mono');
      // A pull request or issue number there has no dialog to open (#3764),
      // so it says where it goes.
      if (/^#\d+$/.test(tokens[idx + 1]?.content ?? '')) {
        tokens[idx].meta = { opensOnForge: true };
      }
    }
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.link_close = (tokens, idx, options, _env, self) => {
    let open = idx - 1;
    while (open >= 0 && tokens[open].type !== 'link_open') open--;
    const note = (tokens[open]?.meta as { opensOnForge?: boolean } | null)
      ?.opensOnForge
      ? '<span class="sr-only"> (opens on the forge in a new tab)</span>'
      : '';
    return note + self.renderToken(tokens, idx, options);
  };
  return md;
}

function load(): Promise<Renderer> {
  // A failed import is not cached: Try again must be able to fetch the chunk
  // once the network is back.
  renderer ??= Promise.all([import('markdown-it'), import('markdown-it-emoji')])
    .then(([{ default: MarkdownItCtor }, { full }]) =>
      create(MarkdownItCtor, full),
    )
    .catch((err) => {
      renderer = null;
      throw err;
    });
  return renderer;
}

// `repoUrl` is the repository the text belongs to; with it, `#12` and
// `owner/repo#12` link to the item on that forge. `monoReferences` gives a
// link labelled with a number or a commit hash the `mono` class.
// `imageSource` maps an image address to where the page loads it from, or
// null to refuse it; without one no image loads.
export async function renderMarkdown(
  text: string,
  options: {
    repoUrl?: string | null;
    references?: ReferenceOptions;
    monoReferences?: boolean;
    imageSource?: ImageSource;
  } = {},
): Promise<string> {
  const repoUrl = options.repoUrl ?? undefined;
  return (await load()).render(text, {
    repoUrl,
    dashboardRefs: options.references,
    monoReferences: options.monoReferences,
    imageSource: options.imageSource,
  });
}
