// The numbers the Home and Releases nav items show, beside the Issues one
// (issue-count.svelte.ts). The dashboard views set them from each snapshot;
// the layout fills them once on pages that don't load a snapshot themselves.
// null until a count is known, so the badge is absent rather than a
// misleading 0.
export const pullRequestCount = $state<{ value: number | null }>({
  value: null,
});
export const releaseCount = $state<{ value: number | null }>({ value: null });

// Release pull requests live on the Releases page and are not counted with the
// rest; the server says which are which (`kind`).
export function setPullRequestCounts(
  pullRequests: { kind?: string }[] | undefined,
) {
  const all = pullRequests ?? [];
  const releases = all.filter((p) => p.kind === 'release').length;
  releaseCount.value = releases;
  pullRequestCount.value = all.length - releases;
}
