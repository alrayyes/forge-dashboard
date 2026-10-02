// Per-pull-request action feedback (#714): one entry per (pull request,
// action), a toast queue, and the one-line sentences a polite live region
// announces. Pure state, no DOM, so it survives the board rebuilding every
// row on each render and each new snapshot. feedback-ui.ts draws it.

export type ActionRef = { key: string; repo: string; number: number };

export type FeedbackPhase =
  | 'working'
  | 'queued'
  // A bot rebase the bot has picked up, until CI shows as restarted (#707).
  | 'rebasing'
  | 'done'
  | 'failed'
  | 'expired';

// Set on a Dependabot/Renovate rebase request (#707): the row line then
// says the bot, not the dashboard's own refresh, is what's being waited on.
export type BotRequest = {
  // "Dependabot" or "Renovate".
  bot: string;
  // How the request reached the bot, in the words of the row line:
  // "comment" is a command comment, "label" the rebase label.
  trigger: 'comment' | 'label';
  // The pull request on its forge, for the "still waiting" link.
  url: string;
  // "GitHub" or "Forgejo".
  forgeLabel: string;
};

export type ActivityEntry = {
  id: number;
  actionKey: string;
  ref: ActionRef;
  // What was asked for, e.g. "Update branch".
  label: string;
  phase: FeedbackPhase;
  // Short status text for the row's inline line, e.g. "Queued".
  inline: string;
  // One-line sentence for toasts and the panel. Never repeats the
  // owner/repo#N reference, which both surfaces show on their own.
  message: string;
  startedAt: number;
  updatedAt: number;
  bot?: BotRequest;
  // Offered as "Retry" once the entry has failed or expired.
  retry?: () => void;
  canRetry: boolean;
};

export type ToastKind = 'success' | 'error';

export type Toast = {
  id: number;
  actionKey: string;
  // Absent for a notice that isn't about one pull request, such as a
  // rate limit resetting; `title` stands in for the reference then.
  ref?: ActionRef;
  title?: string;
  kind: ToastKind;
  message: string;
  retry?: () => void;
};

export type StartInput = {
  actionKey: string;
  ref: ActionRef;
  label: string;
  phase: 'working' | 'queued';
  inline: string;
  message: string;
  // Spoken once, if given. Never includes a countdown.
  announce?: string;
  bot?: BotRequest;
  retry?: () => void;
};

export type UpdateInput = {
  phase?: FeedbackPhase;
  inline?: string;
  message?: string;
  toast?: boolean;
  announce?: string;
  canRetry?: boolean;
};

export type NoticeInput = {
  title: string;
  message: string;
  // Spoken once, if given. Never includes a countdown.
  announce?: string;
};

export const MAX_VISIBLE_TOASTS = 3;
// Keeps a long session's activity list from growing without bound.
const MAX_ENTRIES = 40;

export function isFinished(phase: FeedbackPhase): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'expired';
}

export const PHASE_LABELS: Record<FeedbackPhase, string> = {
  working: 'In progress',
  queued: 'Queued',
  rebasing: 'Rebasing',
  done: 'Done',
  failed: 'Failed',
  expired: 'Timed out',
};

export type FeedbackStore = ReturnType<typeof createFeedbackStore>;

export function createFeedbackStore(now: () => number = Date.now) {
  let nextId = 1;
  // Insertion order, newest last.
  let entries: ActivityEntry[] = [];
  // Newest first.
  let toasts: Toast[] = [];
  const listeners = new Set<() => void>();
  const announcers = new Set<(message: string) => void>();

  function emit() {
    for (const fn of Array.from(listeners)) fn();
  }

  function say(ref: ActionRef, text: string | undefined) {
    if (!text) return;
    const message = `${ref.repo}#${ref.number}: ${text}`;
    for (const fn of Array.from(announcers)) fn(message);
  }

  function find(actionKey: string): ActivityEntry | undefined {
    return entries.find((e) => e.actionKey === actionKey);
  }

  function pushToast(entry: ActivityEntry, kind: ToastKind) {
    toasts = [
      {
        id: nextId++,
        actionKey: entry.actionKey,
        ref: entry.ref,
        kind,
        message: entry.message,
        retry: kind === 'error' && entry.canRetry ? entry.retry : undefined,
      },
      ...toasts,
    ];
  }

  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAnnounce(fn: (message: string) => void): () => void {
      announcers.add(fn);
      return () => announcers.delete(fn);
    },

    // A new action on the same pull request replaces the earlier entry for
    // that action: a Retry reads as one story, not two.
    start(input: StartInput) {
      entries = entries.filter((e) => e.actionKey !== input.actionKey);
      entries.push({
        id: nextId++,
        actionKey: input.actionKey,
        ref: input.ref,
        label: input.label,
        phase: input.phase,
        inline: input.inline,
        message: input.message,
        startedAt: now(),
        updatedAt: now(),
        bot: input.bot,
        retry: input.retry,
        canRetry: false,
      });
      if (entries.length > MAX_ENTRIES) {
        const drop = entries.find((e) => isFinished(e.phase));
        if (drop) entries = entries.filter((e) => e !== drop);
      }
      say(input.ref, input.announce);
      emit();
    },

    // A change to an existing entry; `toast` raises a toast for the new
    // state, `announce` speaks once.
    update(actionKey: string, patch: UpdateInput) {
      const entry = find(actionKey);
      if (!entry) return;
      if (patch.phase) entry.phase = patch.phase;
      if (patch.inline !== undefined) entry.inline = patch.inline;
      if (patch.message !== undefined) entry.message = patch.message;
      if (patch.canRetry !== undefined) entry.canRetry = patch.canRetry;
      entry.updatedAt = now();
      if (patch.toast) {
        // Only a failure or a timeout is an error; a request the forge
        // accepted (still queued) reads as success too.
        pushToast(
          entry,
          entry.phase === 'failed' || entry.phase === 'expired'
            ? 'error'
            : 'success',
        );
      }
      say(entry.ref, patch.announce);
      emit();
    },

    // A success toast that isn't tied to a pull request or an Activity
    // entry (a rate limit that has reset, say).
    notify(input: NoticeInput) {
      toasts = [
        {
          id: nextId++,
          actionKey: `notice:${input.title}`,
          title: input.title,
          kind: 'success',
          message: input.message,
        },
        ...toasts,
      ];
      if (input.announce) {
        for (const fn of Array.from(announcers)) fn(input.announce);
      }
      emit();
    },

    // An action cancelled before it ran leaves no trace.
    drop(actionKey: string) {
      entries = entries.filter((e) => e.actionKey !== actionKey);
      emit();
    },

    // Drops the failed or timed-out entries on one pull request, except
    // the one named: a refusal that settles the row (already merged) makes
    // the earlier failures on it moot.
    dropFailedFor(prKey: string, exceptActionKey: string) {
      const before = entries.length;
      entries = entries.filter(
        (e) =>
          e.ref.key !== prKey ||
          e.actionKey === exceptActionKey ||
          (e.phase !== 'failed' && e.phase !== 'expired'),
      );
      if (entries.length !== before) emit();
    },

    dismissToast(id: number) {
      const before = toasts.length;
      toasts = toasts.filter((t) => t.id !== id);
      if (toasts.length !== before) emit();
    },

    clearFinished() {
      entries = entries.filter((e) => !isFinished(e.phase));
      emit();
    },

    // Newest first.
    entries(): ActivityEntry[] {
      return entries.slice().reverse();
    },
    entriesFor(prKey: string): ActivityEntry[] {
      return entries.filter((e) => e.ref.key === prKey).reverse();
    },
    toasts(): Toast[] {
      return toasts;
    },
    visibleToasts(): Toast[] {
      return toasts.slice(0, MAX_VISIBLE_TOASTS);
    },
    hasQueued(): boolean {
      return entries.some((e) => e.phase === 'queued');
    },
  };
}
