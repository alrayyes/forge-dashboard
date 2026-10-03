// The number the Issues nav item shows (#827). The dashboard views set it
// from each snapshot; the layout fills it once on pages that don't load a
// snapshot themselves. null until a count is known, so the badge is absent
// rather than a misleading 0.
export const issueCount = $state<{ value: number | null }>({ value: null });
