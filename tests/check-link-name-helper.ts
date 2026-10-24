// The accessible name of a pipeline dialog check link that opens the forge in
// a new tab: the visible text, the new-tab warning, then the check. It starts
// with the visible text, so the name still contains the words on screen
// (WCAG 2.5.3). A "View run" button has no warning in its name, since it opens
// the output in place and not a new tab, so the two read differently on
// purpose. When the label changes, change it here and in PipelineDialog.svelte.
export function checkLinkName(text: string, check: string): string {
  return `${text} (opens in a new tab): ${check}`;
}
