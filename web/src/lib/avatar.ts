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

// A refused image carries no cache header, so a redrawn row would ask again.
// A failed address is left alone for this long, then tried once more at the
// next redraw: the proxy being busy passes, so this must not be for good
// (#5124).
export const FAILED_IMAGE_MS = 60_000;

const failedUntil = new Map<string, number>();

// src is what avatarSrc returned, not the <img>'s resolved address.
export function noteImageFailed(src: string, now = Date.now()): void {
  failedUntil.set(src, now + FAILED_IMAGE_MS);
}

export function avatarSrc(
  forge: string,
  url: string | undefined,
  now = Date.now(),
): string | null {
  if (!url || !imagePolicyOf(forge)) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const src = `/api/v1/images?forge=${encodeURIComponent(forge)}&url=${encodeURIComponent(url)}&kind=avatar`;
    return (failedUntil.get(src) ?? 0) > now ? null : src;
  } catch {
    return null;
  }
}

// Puts the picture inside a placeholder that already draws the initial, and
// marks the box once it has loaded so the initial gives way (#5124).
export function drawOverInitial(
  box: HTMLElement,
  src: string,
  className: string,
  size: number,
): void {
  const img = document.createElement('img');
  img.className = className;
  img.alt = '';
  img.width = size;
  img.height = size;
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('load', () => box.classList.add('has-picture'));
  img.addEventListener('error', () => {
    noteImageFailed(src);
    img.remove();
  });
  img.src = src;
  box.appendChild(img);
}
