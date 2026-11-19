import { detailsUrl } from './details-cache.js';

// Whether the forge can show an item of a repository the dashboard does not
// track (#4269). It asks the issues route, which answers a pull request too,
// and returns what the forge said, or null for anything that is not an
// answer: missing, no access, a rate limit, a network failure.
export async function probeReference(
  ref: { forge: string; repo: string; number: number },
  fetcher: typeof fetch = fetch,
): Promise<unknown | null> {
  try {
    const res = await fetcher(detailsUrl({ ...ref, subject: 'issue' }), {
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
