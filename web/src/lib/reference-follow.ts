// Following a mention of an item in a repository the dashboard does not track
// (#4269). The forge is asked first, so the click is answered with the
// dialog when it can show the item and with the forge when it can't.
//
// A tab opened after an await is not tied to the click any more and Safari
// blocks it. So the tab opens first, inside the click, and is closed again
// when the dialog opens or sent to the forge when it can't.

export type Reference = {
  forge: string;
  repo: string;
  number: number;
  url: string;
};

type Tab = { location: { href: string }; close: () => void };

export type FollowDeps = {
  probe: (ref: Reference) => Promise<unknown | null>;
  openTab: () => Tab | null;
  // The details of this item were read before: no lookup, no tab.
  isKnown: (ref: Reference) => boolean;
  remember: (ref: Reference, details: unknown) => void;
  // For a cue on the link while the forge is asked.
  setBusy: (busy: boolean) => void;
};

export type FollowOutcome = 'dialog' | 'forge' | 'ignored';

export function createReferenceFollower(deps: FollowDeps) {
  const waiting = new Set<string>();
  return async (ref: Reference): Promise<FollowOutcome> => {
    if (deps.isKnown(ref)) return 'dialog';
    const key = `${ref.forge}|${ref.repo}|${ref.number}`;
    if (waiting.has(key)) return 'ignored';
    waiting.add(key);
    deps.setBusy(true);
    const tab = deps.openTab();
    try {
      const found = await deps.probe(ref);
      if (found === null) {
        if (tab) tab.location.href = ref.url;
        return 'forge';
      }
      deps.remember(ref, found);
      tab?.close();
      return 'dialog';
    } finally {
      waiting.delete(key);
      deps.setBusy(false);
    }
  };
}
