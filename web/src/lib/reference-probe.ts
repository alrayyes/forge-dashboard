import { detailsUrl } from './details-cache.js';

// How long the forge gets to answer before the reader is sent to it instead.
export const PROBE_TIMEOUT_MS = 8000;

// Whether the forge can show an item of a repository the dashboard does not
// track (#4269). It asks the issues route, which answers a pull request too,
// and returns what the forge said, or null for anything that is not an
// answer: missing, no access, a rate limit, a network failure, no reply in
// time.
export async function probeReference(
  ref: { forge: string; repo: string; number: number },
  fetcher: typeof fetch = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<unknown | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetcher(detailsUrl({ ...ref, subject: 'issue' }), {
      credentials: 'same-origin',
      signal: abort.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
