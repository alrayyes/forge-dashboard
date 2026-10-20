// The avatar is the forge's own URL, passed through unchanged. Only https is
// loaded: the dashboard is served over https, where the browser blocks an
// http image anyway, and javascript: or data: have no business in an <img>.
// Anything else shows the fallback.
export function avatarSrc(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
