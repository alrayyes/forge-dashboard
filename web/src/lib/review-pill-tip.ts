// What the comment pill says on hover and under keyboard focus (#4539): how
// many comments and open threads, then when the newest comment was written.
// The time is a fact from the server (`lastCommentAt`, the newest comment's
// creation time); this file only words it. No comment text goes in: a tip is
// the wrong size for it, and it can't be read by touch.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * "just now", "5 minutes ago", "2 hours ago", "3 days ago": the age in words,
 * so a screen reader doesn't have to read "2h". Empty when there is no usable
 * time. A time ahead of the clock reads as just now.
 */
export function whenWritten(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${plural(hours, 'hour')} ago`;
  return `${plural(Math.round(hours / 24), 'day')} ago`;
}

/**
 * The tip: "4 comments, 1 open thread. Last comment 2 hours ago." Where the
 * time is unknown, the sentence about it is left out, with no empty part.
 */
export function commentPillTip(
  facts: {
    comments: number;
    open: number;
    word: string;
    lastCommentAt?: string | null;
  },
  now: number = Date.now(),
): string {
  const counts =
    facts.open > 0
      ? `${plural(facts.comments, facts.word)}, ${plural(facts.open, 'open thread')}.`
      : `${plural(facts.comments, facts.word)}.`;
  const when = whenWritten(facts.lastCommentAt, now);
  return when ? `${counts} Last comment ${when}.` : counts;
}
