// Which control marks which saved key as touched. Marking is what keeps a saved
// copy that is still loading from overwriting a change made meanwhile (#1713),
// and nothing else says which control must do it. The Insights and Webhooks
// pages call these instead of touching the keys themselves, so each is
// unit-tested. No DOM here.

import {
  type HeldPick,
  heldPicks,
  type PillGroup,
  readCookieState,
  releaseAllHeld,
  releaseHeld,
  type SharedFilterState,
  saveState,
  setPill,
  touchAll,
  touchKey,
} from './filters';
import { type WebhooksFilter, webhooksFilterToState } from './webhooks-filter';

// A shared control (title, forge, repo, author, label) was changed. A pick held
// back for it is let go, since this is the user's own change.
export function setSharedControl(
  state: SharedFilterState,
  col: string,
  value: string,
): void {
  state.shared[col] = value;
  touchKey('shared', col);
  releaseHeld('shared', col);
}

export function setHideDependencyDashboard(
  state: SharedFilterState,
  hide: boolean,
): void {
  state.issue.hideDependencyDashboard = hide ? '1' : '';
  touchKey('issue', 'hideDependencyDashboard');
}

export function setHideTitleRegex(
  state: SharedFilterState,
  pattern: string,
): void {
  state.issue.hideTitleRegex = pattern;
  touchKey('issue', 'hideTitleRegex');
}

export function setPaused(state: SharedFilterState, paused: boolean): void {
  state.view.paused = paused ? '1' : '';
  touchKey('view', 'paused');
}

export function setDrafts(state: SharedFilterState, on: boolean): void {
  state.view.drafts = on ? '1' : '';
  touchKey('view', 'drafts');
}

export function setGroupBy(state: SharedFilterState, value: string): void {
  state.shared.groupBy = value;
  touchKey('shared', 'groupBy');
}

export function setSort(state: SharedFilterState, value: string): void {
  state.view.sort = value;
  touchKey('view', 'sort');
}

// A quick pill was clicked. The Forge group is kept with the shared controls,
// the others with the pull request ones.
export function setQuickPill(
  state: SharedFilterState,
  group: PillGroup,
  pill: string,
): void {
  setPill(state, group, pill);
  touchKey(group === 'forge' ? 'shared' : 'pr', group);
}

// An Any/On/Off style choice: "any" removes the key, so the filter is off.
export function setSegment(
  state: SharedFilterState,
  group: 'pr' | 'issue',
  key: string,
  value: string,
): void {
  if (value === 'any') delete state[group][key];
  else state[group][key] = value;
  touchKey(group, key);
}

// A filter that a row failed was cleared for it, from the group it is kept in.
export function clearFilterFor(
  state: SharedFilterState,
  group: 'shared' | 'pr',
  filter: string,
): void {
  touchKey(group, filter);
  state[group][filter] = '';
  releaseHeld(group, filter);
}

// Clear filters. Emptied in place, since the boards hold these objects. The
// Settings page can replace the dependency dashboard box and the title
// pattern; its own saved values stay, and come back when it is turned off
// (#1630). Every filter counts as touched, so a saved copy still loading does
// not bring the old ones back (#1713).
export function resetFilters(
  state: SharedFilterState,
  settings: { hideDependencyDashboard: boolean; ignoreTitles: boolean },
): void {
  for (const group of [state.shared, state.pr]) {
    for (const k of Object.keys(group)) delete group[k];
  }
  const was: Record<string, string | undefined> = { ...state.issue };
  const keptDashboard = was.hideDependencyDashboard;
  const keptRegex = was.hideTitleRegex;
  for (const k of Object.keys(state.issue)) delete state.issue[k];
  state.issue.hideDependencyDashboard = settings.hideDependencyDashboard
    ? (keptDashboard ?? '1')
    : '1';
  if (settings.ignoreTitles && keptRegex)
    state.issue.hideTitleRegex = keptRegex;
  releaseAllHeld();
  touchAll();
}

// The user dropped one saved pick this page does not offer: it is cleared, kept
// cleared over the saved copy, saved, and the picks still held are returned.
export function releaseHeldPick(
  state: SharedFilterState,
  pick: HeldPick,
): HeldPick[] {
  releaseHeld(pick.group, pick.key);
  touchKey(pick.group, pick.key);
  saveState(state);
  return heldPicks();
}

// The Webhooks filter changed. The keys are touched before the save, so a
// server copy still loading does not overwrite them (#1713). Another tab may
// have saved its own filters since this page loaded; the cookie is shared, so
// start from it and change only this page's group. Returns the state to keep.
export function saveWebhooksFilter(
  saved: SharedFilterState,
  filter: WebhooksFilter,
  keys: string[],
  freeText = false,
): SharedFilterState {
  for (const key of keys) touchKey('webhooks', key);
  let next = saved;
  if (document.cookie.includes('forge-board-filters='))
    next = { ...readCookieState(), webhooks: {} };
  next.webhooks = webhooksFilterToState(filter);
  saveState(next, freeText ? 'title' : undefined);
  return next;
}

export type WebhooksControl = 'forge' | 'repo' | 'status' | 'sort' | 'clear';

const WEBHOOKS_KEYS: Record<WebhooksControl, string[]> = {
  forge: ['forge'],
  repo: ['repo'],
  status: ['status'],
  sort: ['sort', 'dir'],
  clear: ['forge', 'repo', 'status', 'sort', 'dir'],
};

// A Webhooks control changed: the keys it owns are touched and saved. The repo
// box is free text, so its save waits for a pause in typing.
export function saveWebhooksControl(
  saved: SharedFilterState,
  filter: WebhooksFilter,
  control: WebhooksControl,
): SharedFilterState {
  return saveWebhooksFilter(
    saved,
    filter,
    WEBHOOKS_KEYS[control],
    control === 'repo',
  );
}
