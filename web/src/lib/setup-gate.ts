import { isLinked, readSetupFacts } from './setup';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

// Whether the signed-in board has nothing to show, so every page should send
// the person to /setup. It says no whenever it is unsure: an answer that is
// not the setup facts, a failed request, or a board that still reads a token,
// username or installation saved before the OAuth sign-in (settings say one is set), so none of those
// lock an owner out of a board that works.
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
    if (!settings.ok) return true;
    const s = (await settings.json()) as Record<string, unknown>;
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
