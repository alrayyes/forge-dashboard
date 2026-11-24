// Which repos refresh on a schedule instead of instantly (#4028): the ones
// with no confirmed webhook. The same words and the same count show on
// Settings, Repositories and on Branches, so one place works them out.

import { type WebhookReasonFields, webhookNote } from './webhook-reason';

export type PollingRepo = WebhookReasonFields & {
  forge: string;
  fullName: string;
  ignored: boolean;
  hasWebhook: boolean;
  canManageWebhooks?: boolean;
};

export type PollingReason = {
  line: string;
  link: { text: string; href: string };
};

export const POLLING_GUIDE =
  'https://github.com/alrayyes/forge-dashboard/blob/main/docs/webhooks.md#polling-only';

export const isPollingOnly = (r: PollingRepo): boolean =>
  !r.ignored && !r.hasWebhook;

export const pollingOnlyCount = (repos: PollingRepo[]): number =>
  repos.filter(isPollingOnly).length;

export const pollingOnlyKeys = (repos: PollingRepo[]): Set<string> =>
  new Set(repos.filter(isPollingOnly).map((r) => `${r.forge}:${r.fullName}`));

// The filter only means something while a repo still polls. The notice that
// holds its pill is gone at zero, so the filter goes with it (#4786).
export const pollingFilterHolds = (pressed: boolean, count: number): boolean =>
  pressed && count > 0;

export function pollingOnlyNotice(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? '1 repo refreshes on a schedule instead of instantly'
    : `${count} repos refresh on a schedule instead of instantly`;
}

// The line under a polling-only row and the one link that fixes it. A token
// that cannot manage hooks comes first, then an address the forge cannot
// reach, then what the server said about the last attempt.
export function pollingOnlyReason(
  repo: PollingRepo,
  originProblem: string,
  formatTime: (iso: string) => string = (iso) => iso,
): PollingReason {
  const guide = { text: 'See the guide', href: POLLING_GUIDE };
  if (repo.canManageWebhooks === false) {
    return {
      line: 'Polling only: your token cannot manage webhooks here.',
      link: { text: 'Fix in Connections', href: '/settings.html#connections' },
    };
  }
  if (originProblem) {
    return {
      line: 'Polling only: the forge cannot reach this dashboard.',
      link: guide,
    };
  }
  const note = webhookNote(repo, formatTime);
  if (note) return { line: `Polling only: ${note.line}`, link: guide };
  return {
    line: 'Polling only: no webhook is set up for this repo yet.',
    link: guide,
  };
}
