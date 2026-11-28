import type { Unchecked } from './data/api.js';
import { isLinked, readSetupFacts } from './setup';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

// Whether the signed-in board has nothing to show, so every page should send
// the person to /setup. It says no whenever it is unsure: an answer that is
// not the setup facts, a failed request (setup or settings), or a board that
// still reads a token, username or installation saved before the OAuth
// sign-in. None of those lock an owner out of a board that works.
//
// This is a convenience, not a server rule: it runs in the browser after the
// first paint, and a page opened directly still loads. The server only gates
// /setup itself behind a session.
export async function boardNeedsSetup(fetcher: Fetcher): Promise<boolean> {
  try {
    const res = await fetcher('/api/v1/setup', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return false;
    const facts = readSetupFacts(await res.json());
    if (!facts || isLinked(facts)) return false;
    const settings = await fetcher('/api/v1/settings', {
      headers: { Accept: 'application/json' },
    });
    if (!settings.ok) return false;
    const s = (await settings.json()) as Unchecked<'SettingsResponse'>;
    return !(
      s.githubTokenSet === true ||
      s.forgejoTokenSet === true ||
      nonEmpty(s.githubUsername) ||
      nonEmpty(s.forgejoUsername) ||
      Number(s.githubAppInstallationId) > 0
    );
  } catch {
    return false;
  }
}
