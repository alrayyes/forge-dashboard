// A person's profile page is built by the server, from the forge's own web
// address. The page only checks it is a web address before it becomes a link:
// http as well as https, since a self-hosted forge may not use TLS, but never
// javascript: or data:. Anything else shows the name alone.
export function profileHref(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}
