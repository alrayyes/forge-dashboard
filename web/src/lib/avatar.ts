// Avatars and repository logos are the forge's own https URLs, but the page
// never loads them from there: it asks the image proxy, which fetches them
// server-side, so the Content-Security-Policy can name this server alone
// (#3467). The caller says which forge the row belongs to and the proxy URL
// names it; the server holds the host lists for that forge and enforces them.
// A forge nobody described (no image policy) gets no image. Only https is
// loaded: javascript: or data: have no business in an <img>. `kind=avatar`
// tells the server to apply the smaller avatar size cap (#3687). Anything else
// shows the fallback.
import { imagePolicyOf } from './forges';

export function avatarSrc(
  forge: string,
  url: string | undefined,
): string | null {
  if (!url || !imagePolicyOf(forge)) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return `/api/v1/images?forge=${encodeURIComponent(forge)}&url=${encodeURIComponent(url)}&kind=avatar`;
  } catch {
    return null;
  }
}
