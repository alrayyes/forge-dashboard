import type { Page, Route } from '@playwright/test';

// Avatars and repository logos reach the browser through the image proxy, not
// from the forge (#3467). A spec stands in for the forge's image by the
// address the page was asked to show, and asserts on the proxied path.

// The forge of the row the image belongs to: every spec's rows are GitHub's
// unless it says otherwise. The proxy URL names that forge, whatever the image
// host (#4156).
export const DEFAULT_FORGE = 'github';

export function proxiedImage(url: string, forge = DEFAULT_FORGE): string {
  return `/api/v1/images?forge=${forge}&url=${encodeURIComponent(url)}&kind=avatar`;
}

// Matches the proxy request for one image, or for every image whose address
// starts with `url` when it ends in `**`. The request must also name the forge
// of the row, so a page that names the wrong one is not served.
export async function routeImage(
  page: Page,
  url: string,
  handler: (route: Route) => unknown,
  forge = DEFAULT_FORGE,
): Promise<void> {
  const prefix = url.endsWith('**') ? url.slice(0, -2) : null;
  await page.route((u) => {
    if (u.pathname !== '/api/v1/images') return false;
    const target = u.searchParams.get('url') ?? '';
    const matches =
      prefix === null ? target === url : target.startsWith(prefix);
    return matches && u.searchParams.get('forge') === forge;
  }, handler);
}
