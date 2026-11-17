// Copy that names a forge, built from the forge's label so a forge added
// server-side reads right with no edit here (#4073). Behaviour never branches
// on these strings; they are wording only.

import { FORGE_LABELS } from './forges';

function name(forge: string): string {
  return FORGE_LABELS[forge] || forge;
}

export function approveLinkCopy(forge: string): {
  text: string;
  ariaLabel: string;
} {
  const text = `Approve on ${name(forge)}`;
  return { text, ariaLabel: `${text} (opens the checks page in a new tab)` };
}

// The words around a merge the forge itself holds.
export function scheduledOnCopy(forge: string) {
  const n = name(forge);
  return {
    note: `Scheduled on ${n}`,
    cancelled: `Merge scheduled on ${n} cancelled.`,
    cancelling: `Cancelling the merge scheduled on ${n}…`,
    disarmLabel: `Disarm the merge scheduled on ${n}`,
    cancelTitle: `Cancels the merge scheduled on ${n}.`,
  };
}

// The text before the Settings link under a group heading.
export function autoMergeGroupNote(forge: string): string {
  const n = name(forge);
  return `Auto-merge on ${n} is handled by Forge Dashboard, not ${n} itself. Manage it in `;
}

export function forgeNameList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export type PageView = 'issues' | 'releases' | 'bots' | 'pulls';

export function pageDescription(view: PageView): string {
  const where = `across your ${forgeNameList(Object.values(FORGE_LABELS))} repositories`;
  switch (view) {
    case 'issues':
      return `Open issues ${where}, in one list.`;
    case 'releases':
      return `Release pull requests waiting to ship ${where}, with Merge and Update branch on each.`;
    case 'bots':
      return `Dependabot and Renovate pull requests ${where}, with the actions you can take on each.`;
    default:
      return `Open pull requests ${where}, with the actions you can take on each.`;
  }
}
