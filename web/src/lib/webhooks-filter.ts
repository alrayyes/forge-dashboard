// The Webhooks page's forge, repo search, status and sort, as they are kept in
// the shared saved filter state (the `webhooks` group). The page size and the
// current page are not part of it: the page would reopen on a page of a list
// that has changed. No DOM here, so the page stays the one place that touches
// elements.

export type WebhooksSortKey = 'forge' | 'fullName' | 'hasWebhook';

export interface WebhooksFilter {
  // '' is every forge.
  forge: '' | 'github' | 'forgejo';
  repo: string;
  // '' is every status.
  status: '' | 'confirmed' | 'pending';
  sort: WebhooksSortKey;
  dir: 'asc' | 'desc';
}

export const DEFAULT_WEBHOOKS_FILTER: WebhooksFilter = {
  forge: '',
  repo: '',
  status: '',
  sort: 'fullName',
  dir: 'asc',
};

const FORGES = ['', 'github', 'forgejo'];
const STATUSES = ['', 'confirmed', 'pending'];
const SORTS = ['forge', 'fullName', 'hasWebhook'];
const DIRS = ['asc', 'desc'];

// A saved value the page does not know (a stale or hand-edited one) reads as
// the default rather than as a filter nothing can undo.
export function webhooksFilterFromState(
  saved: Record<string, string> | undefined,
): WebhooksFilter {
  const pick = <T extends string>(
    value: unknown,
    allowed: string[],
    fallback: T,
  ): T =>
    typeof value === 'string' && allowed.includes(value)
      ? (value as T)
      : fallback;
  return {
    forge: pick(saved?.forge, FORGES, DEFAULT_WEBHOOKS_FILTER.forge),
    repo: typeof saved?.repo === 'string' ? saved.repo.slice(0, 200) : '',
    status: pick(saved?.status, STATUSES, DEFAULT_WEBHOOKS_FILTER.status),
    sort: pick(saved?.sort, SORTS, DEFAULT_WEBHOOKS_FILTER.sort),
    dir: pick(saved?.dir, DIRS, DEFAULT_WEBHOOKS_FILTER.dir),
  };
}

export function webhooksFilterToState(
  filter: WebhooksFilter,
): Record<string, string> {
  return { ...filter };
}
