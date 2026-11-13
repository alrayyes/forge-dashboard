// The Forgejo avatar hosts the server skipped (#3683). The server only says
// which hosts; this decides whether to show a note and how to word it.

// The list as the server sends it: strings only, trimmed, no blanks, no
// repeats. A server that doesn't send it yet means nothing is skipped.
export function skippedAvatarHosts(raw: unknown): string[] {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const list = data.forgejoSkippedAvatarHosts;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const host = entry.trim();
    if (host) seen.add(host);
  }
  return [...seen];
}

// One host reads "another host", several read "other hosts"; the hosts
// themselves are listed after the colon, in the order given.
export function skippedAvatarLead(hosts: string[]): string {
  return hosts.length === 1
    ? 'Avatars from another host were skipped:'
    : 'Avatars from other hosts were skipped:';
}
