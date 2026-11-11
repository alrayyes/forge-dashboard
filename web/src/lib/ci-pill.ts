// The CI pill every board draws: the pull request and bot rows, the issue
// pills and the Main branches page. The model holds every decision (the word,
// the classes, the counts and the spoken name); renderCiPill draws it, so a
// pill cannot be worded or classed differently on one page.
//
// The spoken word for queued checks stays "waiting". The pipeline dialog says
// "Queued" for one check, but the pill's count joins queued and pending checks,
// and GitHub itself keeps "waiting" (held for an environment) apart from
// "queued" in its status values:
// https://docs.github.com/en/rest/checks/runs#create-a-check-run
// Naming the whole count after one of the states it holds would misname the
// other.

import {
  CHECK_KIND_GLYPH,
  type CheckCounts,
  type CheckSegment,
  checkSegments,
  onlySkipped,
  pillName,
  pillWord,
} from './check-counts';
import { CHECK_GLYPHS } from './check-glyphs';

export type CiPillInput = {
  // The status class the colours hang on: success, failure, pending, ...
  cls: string;
  // The pipeline dialog's glyph for the state, drawn when there are no counts.
  glyph: string;
  word: string;
  awaiting?: boolean;
  counts?: CheckCounts;
  // False for a state that has its own word and no counts (held, a branch's
  // cancelled). A pull request's cancelled pill is the exception: it words the
  // passed and cancelled counts after the state (#3395).
  segmented?: boolean;
};

export type CiPillModel = {
  classes: string;
  glyph: string;
  word: string;
  segments: CheckSegment[];
  // A failed pill whose pipeline has checks running or queued: the failure
  // stands, but the run can still change, so the pill says it is not over.
  live: boolean;
  // A Cancelled pill's counts (#3395), drawn as words after the state: the
  // checks that passed before the stop and the ones it cancelled.
  cancelled?: { passed: number; cancelled: number };
  // The accessible name, without the "Open pipeline" a button adds.
  name: string;
};

// Whether the pill is a Cancelled one that says how far the run got. Needs the
// server's cancelled count; without it the pill is the word alone.
function cancelledCounts(
  input: CiPillInput,
  awaiting: boolean,
): CiPillModel['cancelled'] {
  const n = input.counts?.cancelled;
  if (input.cls !== 'cancelled' || input.segmented === false || awaiting) {
    return undefined;
  }
  if (!input.counts || n === undefined || !Number.isInteger(n) || n <= 0) {
    return undefined;
  }

  return { passed: Math.max(0, input.counts.passed), cancelled: n };
}

// "4 passed, 9 cancelled": a zero passed count is left out, not said.
function cancelledWords({
  passed,
  cancelled,
}: NonNullable<CiPillModel['cancelled']>): string {
  return passed > 0
    ? `${passed} passed, ${cancelled} cancelled`
    : `${cancelled} cancelled`;
}

// "13 checks", or "1 check".
function cancelledTotal({
  passed,
  cancelled,
}: NonNullable<CiPillModel['cancelled']>): string {
  const total = passed + cancelled;

  return `${total} ${total === 1 ? 'check' : 'checks'}`;
}

export function ciPillModel(input: CiPillInput): CiPillModel {
  const awaiting = input.awaiting === true;
  const cancelled = cancelledCounts(input, awaiting);
  const segments =
    input.segmented === false || awaiting || input.cls === 'cancelled'
      ? []
      : checkSegments(input.counts);
  const word = pillWord(input.cls, input.word, segments);
  const segmented = segments.length > 0;
  const live =
    input.cls === 'failure' &&
    segments.some((s) => s.kind === 'running' || s.kind === 'waiting');
  const held = awaiting ? ' awaiting' : '';
  // A fully skipped pass keeps its state class but must not read as a pass.
  const quiet = onlySkipped(input.cls, segments) ? ' all-skipped' : '';
  const classes = `ci-pill ${input.cls}${held}${quiet}${segmented ? ' segmented' : ''}`;

  return {
    classes,
    glyph: input.glyph,
    word,
    segments,
    live,
    cancelled,
    name: cancelled
      ? `CI status: ${word}. ${cancelledWords(cancelled)} out of ${cancelledTotal(cancelled)}.`
      : segmented
        ? `${pillName(word, segments)}${live ? ', still running' : ''}`
        : word,
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function checkGlyphElements(state: string): SVGElement[] {
  return (CHECK_GLYPHS[state] ?? []).map(({ name, body }) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', `check-glyph check-glyph-${name}`);
    svg.setAttribute('data-glyph', name);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    // body comes only from the static CHECK_GLYPHS constant, never forge data.
    svg.innerHTML = body;

    return svg;
  });
}

function span(className: string, text = ''): HTMLElement {
  const e = document.createElement('span');
  e.className = className;
  if (text) e.textContent = text;

  return e;
}

export type RenderOptions = {
  // A button that opens the pipeline, or a badge that opens nothing.
  onOpen?: () => void;
  id?: string;
  // False leaves the words to a name the caller sets (the issue pill).
  announce?: boolean;
};

export function renderCiPill(
  model: CiPillModel,
  options: RenderOptions = {},
): HTMLElement {
  const { onOpen, id, announce = true } = options;
  const segmented = model.segments.length > 0;
  const root = onOpen ? document.createElement('button') : span('');
  root.className = model.classes;
  if (root instanceof HTMLButtonElement) root.type = 'button';

  if (!segmented) {
    const glyphs = checkGlyphElements(model.glyph);
    if (glyphs.length > 0) for (const g of glyphs) root.appendChild(g);
    else root.appendChild(span('dot'));
    if (model.cancelled) {
      const { passed, cancelled } = model.cancelled;
      // One text run, so the pill's gap sits between the glyph and the text and
      // not inside it. The cancelled part leaves a phone when a passed part
      // stays, so the pill keeps to one line; the name and the tooltip say it
      // whole.
      const run = span('ci-cancel');
      run.appendChild(document.createTextNode(`${model.word} · `));
      if (passed > 0) {
        run.appendChild(span('ci-cancel-passed', `${passed} passed`));
        run.appendChild(span('ci-cancel-extra', `, ${cancelled} cancelled`));
      } else {
        run.appendChild(span('ci-cancel-passed', `${cancelled} cancelled`));
      }
      root.appendChild(run);
      root.title = model.name;
    } else {
      root.appendChild(document.createTextNode(model.word));
    }
  } else {
    // The word sits in its own span so a phone can hide it and keep the marker.
    const label = span('ci-seg ci-seg-label');
    label.appendChild(span('ci-word', model.word));
    if (model.live) {
      // The same arc and still clock a running count uses, so the marker
      // honours prefers-reduced-motion with no rule of its own. The name says
      // "still running", so a screen reader skips the glyph.
      const live = span('ci-live');
      live.setAttribute('aria-hidden', 'true');
      for (const g of checkGlyphElements('running')) live.appendChild(g);
      label.appendChild(live);
    }
    root.appendChild(label);
    for (const { kind, n } of model.segments) {
      const seg = span(`ci-seg ci-seg-${kind}`);
      // The counts are said in words by the name (or, on a badge, by the hidden
      // text after them), so a screen reader skips these.
      seg.setAttribute('aria-hidden', 'true');
      for (const g of checkGlyphElements(CHECK_KIND_GLYPH[kind])) {
        seg.appendChild(g);
      }
      seg.appendChild(document.createTextNode(String(n)));
      // A space before each count, so the text reads "Running 5 2 3" and the
      // name contains it whole.
      root.appendChild(document.createTextNode(' '));
      root.appendChild(seg);
    }
  }

  if (onOpen) {
    if (id) root.id = id;
    // The name contains the visible text (WCAG 2.5.3).
    root.setAttribute(
      'aria-label',
      `${model.name}${model.name.endsWith('.') ? '' : '.'} Open pipeline`,
    );
    root.addEventListener('click', onOpen);
  } else if (segmented && announce) {
    // A badge has no name of its own, so a hidden line says it whole and the
    // sighted word is hidden or a screen reader would hear it twice.
    root.querySelector('.ci-seg-label')?.setAttribute('aria-hidden', 'true');
    root.appendChild(span('sr-only', model.name));
  }

  return root;
}
