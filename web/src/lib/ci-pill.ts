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
  // False for a state that has its own word and no counts (cancelled, held).
  segmented?: boolean;
};

export type CiPillModel = {
  classes: string;
  glyph: string;
  word: string;
  segments: CheckSegment[];
  // The accessible name, without the "Open pipeline" a button adds.
  name: string;
};

export function ciPillModel(input: CiPillInput): CiPillModel {
  const awaiting = input.awaiting === true;
  const segments =
    input.segmented === false || awaiting ? [] : checkSegments(input.counts);
  const word = pillWord(input.cls, input.word, segments);
  const segmented = segments.length > 0;
  const held = awaiting ? ' awaiting' : '';
  const classes = `ci-pill ${input.cls}${held}${segmented ? ' segmented' : ''}`;

  return {
    classes,
    glyph: input.glyph,
    word,
    segments,
    name: segmented ? pillName(word, segments) : word,
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
    root.appendChild(document.createTextNode(model.word));
  } else {
    root.appendChild(span('ci-seg ci-seg-label', model.word));
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
    // The visible word leads the name (WCAG 2.5.3).
    root.setAttribute('aria-label', `${model.name}. Open pipeline`);
    root.addEventListener('click', onOpen);
  } else if (segmented && announce) {
    // A badge has no name of its own, so a hidden line says it whole and the
    // sighted word is hidden or a screen reader would hear it twice.
    root.querySelector('.ci-seg-label')?.setAttribute('aria-hidden', 'true');
    root.appendChild(span('sr-only', model.name));
  }

  return root;
}
