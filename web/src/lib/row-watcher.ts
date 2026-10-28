import type { CheckFeedMessage, RunFacts, Subject } from './check-feed';
import { branchKey } from './main-branches';
import type { Check } from './pipeline-checks';

type Options = {
  feed: {
    watch(
      subject: Subject,
      follower: (m: CheckFeedMessage) => void,
    ): () => void;
  };
  // How a subject is named in onChecks and onDrop. A branch row is one per
  // repo; a pull request row needs its number too.
  keyOf?: (subject: Subject) => string;
  onChecks: (key: string, checks: Check[], runs: RunFacts[]) => void;
  onDrop: (key: string) => void;
};

// Follows the job lists of the rows a page shows. Each call to set names the
// rows now wanted: the ones already followed stay as they are, so a filter
// change posts a watch for what is new and lets go of what left, not of
// everything. A row let go of is dropped, so its pill reads the refresh again.
export function createRowWatcher({
  feed,
  keyOf = branchKey,
  onChecks,
  onDrop,
}: Options) {
  const stops = new Map<string, () => void>();

  function drop(key: string) {
    stops.get(key)?.();
    stops.delete(key);
    onDrop(key);
  }

  return {
    set(wanted: readonly Subject[]) {
      const keys = new Set(wanted.map(keyOf));

      // Let go first. Each watch posts the whole watched set as it stands, so
      // watching the new rows while the departed are still held would post more
      // than the stream takes, and the server refuses a post over its cap.
      for (const key of [...stops.keys()]) if (!keys.has(key)) drop(key);
      for (const subject of wanted) {
        const key = keyOf(subject);
        if (stops.has(key)) continue;

        stops.set(
          key,
          feed.watch(subject, (message) => {
            if ('checks' in message)
              onChecks(key, message.checks, message.runs ?? []);
          }),
        );
      }
    },
    stop() {
      for (const key of [...stops.keys()]) drop(key);
    },
  };
}
