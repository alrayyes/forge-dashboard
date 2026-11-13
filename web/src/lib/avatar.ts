// Avatars and repository logos are the forge's own https URLs, but the page
// never loads them from there: it asks the image proxy, which fetches them
// server-side, so the Content-Security-Policy can name this server alone
// (#3467). The server holds the host lists and enforces them; a GitHub host
// goes to the GitHub list and anything else to the saved Forgejo instance,
// which refuses a host that is not its own. Only https is loaded: javascript:
// or data: have no business in an <img>. `kind=avatar` tells the server to
// apply the smaller avatar size cap (#3687). Anything else shows the fallback.
const GITHUB_AVATAR_HOSTS = new Set([
  'avatars.githubusercontent.com',
  'repository-images.githubusercontent.com',
]);

export function avatarSrc(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const forge = GITHUB_AVATAR_HOSTS.has(u.hostname) ? 'github' : 'forgejo';
    return `/api/v1/images?forge=${forge}&url=${encodeURIComponent(url)}&kind=avatar`;
  } catch {
    return null;
  }
}
