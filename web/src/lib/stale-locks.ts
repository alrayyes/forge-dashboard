type Entry = { phase: string; code?: string };

// Clears every "locked for good" entry in the given action state maps. Called
// on each fresh snapshot, so a lock only reflects the latest data instead of
// latching until a reload. In-flight phases ('confirming', 'merging',
// 'queued') stay: they track a request in progress, not an old conclusion.
// `holds` names a lock a snapshot can't re-derive (a permission refusal).
export function clearStaleLocks<E extends Entry>(
  stateMaps: Record<string, E>[],
  holds: (entry: E) => boolean,
): void {
  for (const stateMap of stateMaps) {
    for (const key of Object.keys(stateMap)) {
      const entry = stateMap[key];
      if (entry.phase === 'locked' && !holds(entry)) delete stateMap[key];
    }
  }
}
