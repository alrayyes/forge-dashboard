// The five Settings groups and the URL hash that picks one. A hash is either
// a group id ("#behaviour") or the id of a card that older links point at
// ("#api-tokens"); the second opens the card's group and names the card so
// the page can scroll it into view.

export type SettingsGroupId =
  | 'display'
  | 'sharing'
  | 'connections'
  | 'behaviour'
  | 'integrations';

export const SETTINGS_GROUPS: {
  id: SettingsGroupId;
  label: string;
  caption: string;
}[] = [
  { id: 'display', label: 'Display', caption: 'Theme, time zone' },
  { id: 'sharing', label: 'Sharing', caption: 'Share your dashboard' },
  { id: 'connections', label: 'Connections', caption: 'GitHub, Forgejo' },
  {
    id: 'behaviour',
    label: 'Behaviour',
    caption: 'Pull requests, issues, auto-merge',
  },
  {
    id: 'integrations',
    label: 'Integrations and security',
    caption: 'Webhooks, passkeys, API tokens',
  },
];

export const DEFAULT_GROUP: SettingsGroupId = 'display';

// Card and field ids that existing links use, and the group each lives in.
const ANCHOR_GROUPS: Record<string, SettingsGroupId> = {
  'issue-settings': 'behaviour',
  'forgejo-auto-merge': 'behaviour',
  webhooks: 'integrations',
  passkeys: 'integrations',
  'api-tokens': 'integrations',
  'github-token': 'connections',
  'forgejo-token': 'connections',
  'forgejo-url': 'connections',
  'shared-with-me-list': 'sharing',
  'timezone-select': 'display',
};

export function groupFromHash(hash: string): {
  group: SettingsGroupId;
  anchor?: string;
} {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // keep the raw text
  }
  const direct = SETTINGS_GROUPS.find((g) => g.id === id);
  if (direct) return { group: direct.id };
  const group = ANCHOR_GROUPS[id];
  if (group) return { group, anchor: id };
  return { group: DEFAULT_GROUP };
}
