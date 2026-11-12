import type { Page, Route } from '@playwright/test';

// Avatars and repository logos reach the browser through the image proxy, not
// from the forge (#3467). A spec stands in for the forge's image by the
// address the page was asked to show, and asserts on the proxied path.

// Which forge's list the proxy checks an address against.
export function forgeFor(url: string): 'github' | 'forgejo' {
  return /^https:\/\/(avatars|repository-images)\.githubusercontent\.com\//.test(
    url,
  )
    ? 'github'
    : 'forgejo';
}

export function proxiedImage(url: string): string {
  const forge = forgeFor(url);
  return `/api/v1/images?forge=${forge}&url=${encodeURIComponent(url)}`;
}

// Matches the proxy request for one image, or for every image whose address
// starts with `url` when it ends in `**`. The request must also name the forge
// the address belongs to, so a page that picks the wrong list is not served.
export async function routeImage(
  page: Page,
  url: string,
  handler: (route: Route) => unknown,
): Promise<void> {
  const prefix = url.endsWith('**') ? url.slice(0, -2) : null;
  await page.route((u) => {
    if (u.pathname !== '/api/v1/images') return false;
    const target = u.searchParams.get('url') ?? '';
    const matches =
      prefix === null ? target === url : target.startsWith(prefix);
    return matches && u.searchParams.get('forge') === forgeFor(target);
  }, handler);
}
