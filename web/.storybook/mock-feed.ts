// The pipeline dialog reads its job list off the dashboard stream, not over
// fetch. This stands in for the server end of that stream: it attaches a fake
// event source to the page's real check feed, and when the dialog posts its
// watch it answers with the event a story hands it. The feed and the dialog
// are the real code.
import {
  checkFeed,
  type FeedSource,
  type Subject,
} from '../src/lib/check-feed';
import type { Check } from '../src/lib/pipeline-checks';
import { mockFetch } from './mock-fetch';

export type FeedAnswer =
  | { checks: Check[]; runs?: Record<string, unknown>[] }
  | { error: string }
  // Never answers, for a loading state.
  | null;

export function mockFeed(
  answer: (subject: Subject) => FeedAnswer,
  extra: Parameters<typeof mockFetch>[0] = [],
): () => void {
  const listeners: Record<string, (event: { data?: string }) => void> = {};
  const source: FeedSource = {
    readyState: 1,
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
  };
  checkFeed.attach(source);
  // A new connection: the feed forgets what the last story left held.
  listeners.open?.({});
  const restore = mockFetch([
    ...extra,
    {
      match: /\/api\/v1\/dashboard\/stream\/watch/,
      status: 204,
      onCall: (body) => {
        const { subjects = [] } = JSON.parse(body || '{}') as {
          subjects?: Subject[];
        };
        for (const subject of subjects) {
          const reply = answer(subject);
          if (!reply) continue;
          setTimeout(() => {
            const base =
              'error' in reply
                ? { ...subject, error: reply.error }
                : {
                    ...subject,
                    key: 'run-1',
                    final: true,
                    checks: reply.checks,
                    ...(reply.runs?.[0] ?? {}),
                  };
            listeners.run?.({ data: JSON.stringify(base) });
          }, 0);
        }
      },
    },
  ]);
  return restore;
}
