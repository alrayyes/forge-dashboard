// The waiting chip (#1229): one status chip in a pull request row's action
// area for every "something is happening, hold on" state: a bot rebase, an
// Update branch, a merge or a close in flight, an armed Forgejo auto-merge,
// and the two ends of a wait (Settled, Still waiting).
//
// All of the wording lives here, so the states read alike: an icon, a bold
// label of at most three words, a lighter second line naming the actor or the
// reason, and the fuller explanation as a tooltip. waitChip() and friends are
// pure; buildWaitChip() draws one. feedback-ui.ts decides when a chip shows
// for an action, Dashboard.svelte for an armed auto-merge.

// How long a wait runs with no change before the chip says so.
export const STILL_WAITING_MS = 120_000;

// How long Settled stays before the row returns to its normal actions.
export const SETTLED_MS = 4_000;

export type WaitKind =
  | 'bot-rebase'
  | 'bot-recreate'
  | 'update-branch'
  | 'merge'
  | 'close'
  | 'enable-auto-merge'
  | 'cancel-auto-merge';

export type WaitPhase = 'working' | 'queued' | 'rebasing';

// The kinds that leave the row in place when they finish. A merge or a close
// takes the row off the board, so there is nothing to settle on.
export function settlesOnRow(kind: WaitKind): boolean {
  return (
    kind === 'bot-rebase' || kind === 'bot-recreate' || kind === 'update-branch'
  );
}

export type ChipIcon = 'spinner' | 'hourglass' | 'check' | 'retry';

// What a chip offers, if anything. The button itself is the caller's: only it
// knows what the click does.
export type ChipAction = 'check-again' | 'disarm' | 'cancel';

export type Chip = {
  state: 'waiting' | 'stalled' | 'settled';
  icon: ChipIcon;
  // At most three words.
  label: string;
  // The lighter line: the actor or the reason. May be empty when a ticking
  // part (ago, countdown) carries it.
  detail: string;
  // The fuller explanation, shown on hover and on keyboard focus.
  tooltip: string;
  // A "45s ago" that keeps ticking after the detail.
  showAgo: boolean;
  // A "Next refresh in 12s" that keeps ticking after the detail.
  countdown: boolean;
  // A "Resets in 8m" that keeps ticking as the detail.
  resets?: boolean;
  action?: ChipAction;
};

export type WaitInput = {
  kind: WaitKind;
  phase: WaitPhase;
  // "Dependabot" or "Renovate", for the bot kinds.
  bot?: string;
  // The bot reacted to the command comment.
  acknowledged?: boolean;
  // How the request reached the bot: a command comment or the rebase label.
  trigger?: 'comment' | 'label';
  // How long since the last change the page saw.
  sinceChangeMs: number;
};

const SUBJECT: Record<WaitKind, (bot: string) => string> = {
  'bot-rebase': (bot) => `The ${bot} rebase`,
  'bot-recreate': (bot) => `The ${bot} recreate`,
  'update-branch': () => 'The branch update',
  merge: () => 'The merge',
  close: () => 'The close',
  'enable-auto-merge': () => 'Arming auto-merge',
  'cancel-auto-merge': () => 'Disarming auto-merge',
};

function stalled(input: WaitInput): Chip {
  const subject = SUBJECT[input.kind](input.bot ?? 'bot');
  return {
    state: 'stalled',
    icon: 'retry',
    label: 'Still waiting',
    detail: 'Over 2 min',
    tooltip: `${subject} has had no change for over two minutes. Check again reads this row from the forge now.`,
    showAgo: false,
    countdown: false,
    action: 'check-again',
  };
}

export function waitChip(input: WaitInput): Chip {
  if (input.sinceChangeMs >= STILL_WAITING_MS) return stalled(input);
  const bot = input.bot ?? 'The bot';
  const base = { state: 'waiting', icon: 'spinner' } as const;
  switch (input.kind) {
    case 'bot-rebase':
    case 'bot-recreate': {
      const noun = input.kind === 'bot-rebase' ? 'rebase' : 'recreate';
      if (input.phase === 'rebasing')
        return {
          ...base,
          label: 'Rebasing',
          detail: bot,
          tooltip: `${bot} picked this up and pushed it. This clears when CI restarts.`,
          showAgo: true,
          countdown: false,
        };
      const how = input.trigger === 'label' ? ' The rebase label is set.' : '';
      return {
        ...base,
        label: input.kind === 'bot-rebase' ? 'Rebase requested' : 'Recreating',
        detail: input.acknowledged ? `${bot} got it` : bot,
        tooltip: input.acknowledged
          ? `${bot} has seen your ${noun} command and hasn't pushed yet. No need to ask again.`
          : `${bot} acts on its own schedule, usually within a few minutes.${how} No need to ask again.`,
        showAgo: true,
        countdown: false,
      };
    }
    case 'update-branch':
      return {
        ...base,
        label: 'Updating branch',
        detail: '',
        tooltip:
          'The forge is bringing the branch up to date. The row changes at the next refresh.',
        showAgo: false,
        countdown: true,
      };
    case 'merge':
      return {
        ...base,
        label: 'Merging',
        detail: 'With the forge',
        tooltip:
          'The merge request is with the forge. The row leaves the list once it shows as merged.',
        showAgo: false,
        countdown: false,
      };
    case 'close':
      return {
        ...base,
        label: 'Closing',
        detail: 'With the forge',
        tooltip:
          'The close request is with the forge. The row leaves the list once it shows as closed.',
        showAgo: false,
        countdown: false,
      };
    case 'enable-auto-merge':
      return {
        ...base,
        label: 'Arming',
        detail: 'Auto-merge',
        tooltip:
          'Forge Dashboard is turning auto-merge on for this pull request.',
        showAgo: false,
        countdown: false,
      };
    case 'cancel-auto-merge':
      return {
        ...base,
        label: 'Disarming',
        detail: 'Auto-merge',
        tooltip:
          'Forge Dashboard is turning auto-merge off for this pull request.',
        showAgo: false,
        countdown: false,
      };
  }
}

// A wait that ended well: `message` is the sentence the toast carries, such
// as "Branch updated.".
export function settledChip(message: string): Chip {
  return {
    state: 'settled',
    icon: 'check',
    label: 'Settled',
    detail: message.replace(/\.$/, ''),
    tooltip: message,
    showAgo: false,
    countdown: false,
  };
}

// An action queued for a rate limit's reset (#756): `time` is the reset as
// HH:MM, `at` the same with its date and zone for the hint, `verb` what will
// run ("update" or "rebase").
export function queuedChip(input: {
  time: string;
  at: string;
  verb: string;
}): Chip {
  return {
    state: 'waiting',
    icon: 'hourglass',
    label: `Queued · ${input.time}`,
    detail: '',
    tooltip: `The forge's rate limit resets at ${input.at}. Forge Dashboard runs the ${input.verb} then, if it still applies.`,
    showAgo: false,
    countdown: false,
    resets: true,
    action: 'cancel',
  };
}

export type AutoMergeInput = {
  state: 'waiting' | 'stopped';
  code?: string;
  // The server's own sentence, kept as the tooltip.
  message: string;
  draft: boolean;
  // Who merges an armed pull request that has nothing left to wait for.
  forge: string;
};

// An armed Forgejo auto-merge that is waiting. A stopped one needs a person,
// so it is no wait and gets no chip.
export function autoMergeChip(input: AutoMergeInput): Chip | null {
  if (input.state !== 'waiting') return null;
  const words = (label: string, detail: string) => ({
    state: 'waiting' as const,
    icon: 'hourglass' as const,
    label,
    detail,
    tooltip: input.message,
    showAgo: false,
    countdown: false,
    action: 'disarm' as const,
  });
  switch (input.code) {
    case 'checks_pending':
      return words('Waiting for CI', 'Merges when CI passes');
    case 'stacked':
      return words('Waiting for parent', 'Merges after its parent');
    case 'rate_limited':
      return words('Rate limited', 'Retries after the reset');
    case '':
    case undefined:
      // Forgejo's intent is held here and acted on at the next refresh;
      // GitHub's own auto-merge merges as soon as it can (#1505).
      return input.forge === 'github'
        ? words('Merging', 'GitHub merges it as soon as it can')
        : words('Merging next', 'On the next refresh');
    default:
      return input.draft
        ? words('Waiting for ready', 'Merges once marked ready')
        : words('Waiting for forge', 'Merges when it allows');
  }
}

// ---- what a screen reader hears, once per change ----
export function requestedAnnouncement(kind: WaitKind, bot?: string): string {
  switch (kind) {
    case 'bot-rebase':
      return `${bot} rebase requested.`;
    case 'bot-recreate':
      return `${bot} recreate requested.`;
    case 'update-branch':
      return 'Branch update requested.';
    case 'merge':
      return 'Merging…';
    case 'close':
      return 'Closing…';
    case 'enable-auto-merge':
      return 'Enabling auto-merge…';
    case 'cancel-auto-merge':
      return 'Cancelling auto-merge…';
  }
}

export function stalledAnnouncement(kind: WaitKind, bot?: string): string {
  return `Still waiting. ${SUBJECT[kind](bot ?? 'bot')} has had no change for two minutes. Check again is on the row.`;
}

// ---- drawing ----
const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS: Record<ChipIcon, string[]> = {
  spinner: ['M21 12a9 9 0 1 1-6.2-8.55'],
  hourglass: ['M6 2h12', 'M6 22h12', 'M7 2v4l5 6-5 6v4', 'M17 2v4l-5 6 5 6v4'],
  check: ['M20 6 9 17l-5-5'],
  retry: ['M21 12a9 9 0 1 1-3-6.7', 'M21 3v6h-6'],
};

function icon(kind: ChipIcon): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `wait-chip-icon wait-chip-${kind}`);
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[kind]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function span(className: string, text = ''): HTMLElement {
  const e = document.createElement('span');
  e.className = className;
  if (text) e.textContent = text;
  return e;
}

export type ChipDrawing = {
  // Where the chip comes from, so one source can replace its own chip.
  source: 'feedback' | 'auto-merge' | 'queued';
  // Names the chip for a screen reader: the pull request it is on.
  subject: string;
  // The button the chip offers, already wired. Only passed where the chip's
  // `action` says one exists.
  button?: HTMLElement;
  // The ticking parts, owned by the caller so one timer keeps them current.
  ago?: HTMLElement;
  countdown?: HTMLElement;
  resets?: HTMLElement;
};

let chipCounter = 0;

export function buildWaitChip(chip: Chip, drawing: ChipDrawing): HTMLElement {
  const root = document.createElement('div');
  root.className = 'wait-chip';
  root.dataset.state = chip.state;
  root.dataset.source = drawing.source;
  // Focusable so the tooltip opens from the keyboard, as it does on hover.
  root.tabIndex = 0;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', `${chip.label}, ${drawing.subject}`);
  const tipId = `wait-chip-tip-${chipCounter++}`;
  root.setAttribute('aria-describedby', tipId);

  root.appendChild(icon(chip.icon));

  const text = span('wait-chip-text');
  text.appendChild(span('wait-chip-label', chip.label));
  const detail = span('wait-chip-detail');
  const parts: (string | HTMLElement)[] = [];
  if (chip.detail) parts.push(chip.detail);
  if (chip.showAgo && drawing.ago) parts.push(drawing.ago);
  if (chip.countdown && drawing.countdown) parts.push(drawing.countdown);
  if (chip.resets && drawing.resets) parts.push(drawing.resets);
  parts.forEach((part, i) => {
    if (i > 0) detail.appendChild(document.createTextNode(' · '));
    detail.appendChild(
      typeof part === 'string' ? document.createTextNode(part) : part,
    );
  });
  text.appendChild(detail);
  root.appendChild(text);

  if (drawing.button) root.appendChild(drawing.button);

  const tip = span('wait-chip-tip', chip.tooltip);
  tip.id = tipId;
  tip.setAttribute('role', 'tooltip');
  root.appendChild(tip);
  return root;
}
