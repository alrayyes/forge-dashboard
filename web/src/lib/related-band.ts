// The Related band at the top of the pull request and issue dialogs (#4220):
// which rows it has, how many items it counts and how a row folds. The pill
// markup itself stays with the row builders (closing-issues.ts,
// mentioned-issues.ts, linked-pull-requests.ts), which draw a dialog's pills
// when they are handed `inDialog`; this module is what they share. It imports
// nothing from them, so each can import it.

import { focusPill } from './pill-tip.js';

/** How many pills a row of the band shows before the rest wait behind a count. List rows keep their own, SHOWN_PILLS. */
export const DIALOG_SHOWN_PILLS = 6;

/** What a pull request does to an issue, or an issue to a pull request. */
export type RelatedRelation = 'closes' | 'refs' | 'mentions';

/**
 * Whose dialog the band sits in, or which of an issue's two directions a row
 * is: 'issue' is what refers to the issue, 'issue-outgoing' what the issue
 * itself refers to (#4272).
 */
export type RelatedSide = 'pull-request' | 'issue' | 'issue-outgoing';

const DOES: Record<RelatedRelation, string> = {
  closes: 'Closes',
  refs: 'Refs',
  mentions: 'Mentions',
};

const LABELS: Record<RelatedSide, Record<RelatedRelation, string>> = {
  'pull-request': DOES,
  'issue-outgoing': DOES,
  issue: {
    closes: 'Closed by',
    refs: 'Referenced by',
    mentions: 'Mentioned by',
  },
};

/** A row's label, which is also the relation an accessible name leads with. */
export const relationLabel = (side: RelatedSide, relation: RelatedRelation) =>
  LABELS[side][relation];

/** The pills a row shows, and the ones kept behind the count. */
export function foldSplit<T>(list: T[], limit: number = DIALOG_SHOWN_PILLS) {
  return { shown: list.slice(0, limit), rest: list.slice(limit) };
}

/** The toggle's visible text. */
export const foldToggleText = (rest: number, expanded: boolean) =>
  expanded ? 'Show fewer' : `+${rest} more`;

/**
 * The toggle's accessible name. It starts with the visible text (WCAG 2.5.3)
 * and then says what the button does to which pills.
 */
export function foldToggleName(rest: number, expanded: boolean, what: string) {
  const text = foldToggleText(rest, expanded);
  return expanded
    ? `${text}, hides ${rest} ${what}`
    : `${text}, ${rest} more ${what}`;
}

type Ref = { repo: string; number: number };

/** The distinct items across the rows, not the rows: one item in two rows counts once. */
export function relatedCount(lists: (readonly Ref[] | undefined)[]) {
  const seen = new Set<string>();
  for (const list of lists)
    for (const item of list ?? [])
      seen.add(`${item.repo.toLowerCase()}#${item.number}`);
  return seen.size;
}

export type RelatedRow = {
  /** Unique in a band: an issue has a refs row for each direction. */
  key: string;
  relation: RelatedRelation;
  label: string;
};

/** The rows the band has, in order. A row with no items is left out, and so is the band when none has. */
export function relatedRows(
  side: RelatedSide,
  lists: Partial<Record<RelatedRelation, readonly unknown[] | undefined>>,
): RelatedRow[] {
  const order: RelatedRelation[] = ['closes', 'refs', 'mentions'];
  return order
    .filter((relation) => (lists[relation]?.length ?? 0) > 0)
    .map((relation) => ({
      key: side === 'issue-outgoing' ? `outgoing-${relation}` : relation,
      relation,
      label: relationLabel(side, relation),
    }));
}

export type RelatedBandRow = RelatedRow & {
  /** The row's pills, as the row builders draw them. */
  node: HTMLElement;
};

export type RelatedBandData = { count: number; rows: RelatedBandRow[] };

type BandLists = Partial<Record<RelatedRelation, readonly Ref[] | undefined>>;
type BandNodes = Partial<Record<RelatedRelation, HTMLElement | null>>;

const rowsWithNodes = (side: RelatedSide, lists: BandLists, nodes: BandNodes) =>
  relatedRows(side, lists).flatMap((row) => {
    const node = nodes[row.relation];
    return node ? [{ ...row, node }] : [];
  });

/**
 * The band for one dialog: the rows that have items and a node, the count of
 * distinct items, and undefined when there is nothing to show. An issue's
 * band takes what the issue itself refers to as `outgoing`, drawn after the
 * rows of what refers to it.
 */
export function relatedBandData(
  side: RelatedSide,
  lists: BandLists,
  nodes: BandNodes,
  outgoing?: { lists: BandLists; nodes: BandNodes },
): RelatedBandData | undefined {
  const rows = [
    ...rowsWithNodes(side, lists, nodes),
    ...(outgoing
      ? rowsWithNodes('issue-outgoing', outgoing.lists, outgoing.nodes)
      : []),
  ];
  if (rows.length === 0) return undefined;
  const all = [lists, outgoing?.lists ?? {}].flatMap((l) => [
    l.closes,
    l.refs,
    l.mentions,
  ]);
  return { count: relatedCount(all), rows };
}

/** A row's pills whose hidden ones the reader opened, so a redrawn band keeps them open. */
const expanded = new Set<string>();

/** The pills a toggle keeps out of the page while the row is folded (#4328): patchPills writes them too. */
export const foldedExtras = new WeakMap<HTMLElement, HTMLElement[]>();

/**
 * Draws a band row's pills: the first DIALOG_SHOWN_PILLS, and when more are
 * kept back one persistent toggle after them. It stays where it is, reads
 * "+N more" and then "Show fewer", and reports `aria-expanded`.
 */
export function foldedPills<T>(
  key: string,
  list: T[],
  pill: (item: T) => HTMLElement,
  what: string,
): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'linked-prs';
  const { shown, rest } = foldSplit(list);
  wrap.append(...shown.map(pill));
  if (rest.length === 0) return wrap;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'linked-pr-more related-toggle';
  const extra = rest.map(pill);
  foldedExtras.set(toggle, extra);
  const draw = (open: boolean) => {
    // The chevron is a node of its own: the pills' ::after is the phone hit area.
    const chevron = document.createElement('span');
    chevron.className = 'related-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    toggle.replaceChildren(foldToggleText(rest.length, open), chevron);
    toggle.setAttribute('aria-label', foldToggleName(rest.length, open, what));
    toggle.setAttribute('aria-expanded', String(open));
    if (open) toggle.before(...extra);
    else for (const node of extra) node.remove();
  };
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    draw(open);
    if (open) expanded.add(key);
    else expanded.delete(key);
    if (open) focusPill(extra[0]);
  });
  wrap.append(toggle);
  draw(expanded.has(key));
  return wrap;
}

/**
 * Puts a cross-repo number in two nodes, so the repo alone is cut short with
 * an ellipsis and the number stays whole. Returns false, adding nothing, for a
 * bare number.
 */
export function appendRepoRef(
  link: HTMLElement,
  repo: string,
  number: number,
  bare: boolean,
): boolean {
  if (bare) return false;
  const refNode = document.createElement('span');
  refNode.className = 'linked-pr-ref';
  const repoNode = document.createElement('span');
  repoNode.className = 'linked-pr-repo';
  repoNode.textContent = repo;
  repoNode.title = repo;
  const numberNode = document.createElement('span');
  numberNode.className = 'linked-pr-number';
  numberNode.textContent = `#${number}`;
  refNode.append(repoNode, numberNode);
  link.append(refNode);
  return true;
}
