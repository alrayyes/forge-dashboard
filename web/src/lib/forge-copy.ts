// Copy that names a forge, built from the forge's label so a forge added
// server-side reads right with no edit here (#4073). Behaviour never branches
// on these strings; they are wording only.

import { FORGE_LABELS, forgeLabelOf } from './forges';

function name(forge: string): string {
  return forgeLabelOf(forge);
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
    cancelLabel: `Cancel auto-merge scheduled on ${n}`,
    cancelTitle: `Cancels the merge scheduled on ${n}.`,
  };
}

// The text before the Settings link under a group heading.
export function autoMergeGroupNote(forge: string): string {
  const n = name(forge);
  return `Auto-merge on ${n} is handled by Forge Dashboard, not ${n} itself. Manage it in `;
}

export function forgeNameList(
  names: readonly string[],
  conjunction = 'and',
): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}`;
}

// The Webhooks page's empty state.
export function noReposCopy(): string {
  const forges = forgeNameList(Object.values(FORGE_LABELS), 'or');
  return `Nothing tracked yet — save ${forges} credentials in Settings first.`;
}

// The Webhooks row of a repo the forge listed without the user's permissions.
export function permissionsNotReportedCopy(forge: string): string {
  return `${name(forge)} didn't report your access on this repo, so the dashboard can't tell if you can manage its webhooks.`;
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

// The Webhooks page's words about an app connection, named by the forge's label.
export function appConnectionCopy(forge: string) {
  const n = name(forge);
  return {
    missingWebhookPermission: `Give your ${n} App the Webhooks (read and write) permission, then accept it on the installation, or `,
    dependabotNeedsToken: `Dependabot needs a personal access token when a ${n} App is connected.`,
  };
}

// The Connections group's caption in Settings.
export function connectionsCaption(): string {
  return Object.values(FORGE_LABELS).join(', ');
}

// The Settings page's meta description.
export function settingsDescription(): string {
  const forges = forgeNameList(Object.values(FORGE_LABELS));
  const connections = forges ? `${forges} connections` : 'connections';
  return `Your appearance, ${connections}, pull request behavior, webhooks, passkeys and API tokens.`;
}

// The Settings card for a forge whose auto-merge this app holds and performs.
export function appHeldAutoMergeCopy(forge: string) {
  const n = name(forge);
  return {
    heading: `${n} auto-merge`,
    intro: `Auto-merge on ${n} is handled by Forge Dashboard, not ${n} itself. ${n}'s own scheduled merge can't be read back, so this app keeps the intent and does the merging.`,
    items: [
      `It's off for every pull request until you choose "Enable auto-merge" in a ${n} pull request's pop-up. Nothing is merged that you didn't arm.`,
      `An armed pull request shows "Auto-merge on" and "Managed by Forge Dashboard". It merges after a refresh once its checks have passed and ${n} says it can merge, with the repo's own merge method.`,
      `While it waits or stops, the row says why in words: checks still running, a failed check, a conflict, or a merge ${n} refused.`,
      `"Cancel auto-merge" on the row removes the intent. Closing or merging the pull request elsewhere removes it too.`,
      `The merge uses your ${n} token, so it needs permission to merge.`,
    ],
  };
}
