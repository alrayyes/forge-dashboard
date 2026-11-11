// Where an image embedded in a pull request, issue or release is loaded from
// (#3405). The page never asks a forge or a third party for it: it asks this
// server, which fetches it with the saved token and passes the bytes on. This
// decides which addresses are worth asking for; the server holds the same
// list and is the one that enforces it, so a refusal here is only a saved
// round trip and a link instead of a broken picture.
const GITHUB_HOSTS = new Set([
  'github.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'raw.githubusercontent.com',
]);

export type ImageSource = (src: string) => string | null;

function parse(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.username || u.password ? null : u;
  } catch {
    return null;
  }
}

function proxied(forge: string, src: string): string {
  return `/api/v1/images?forge=${forge}&url=${encodeURIComponent(src)}`;
}

// `repoUrl` is the repository the text belongs to. A Forgejo item may embed
// images from its own instance only; a GitHub item from GitHub's own hosts.
export function imageSourceFor(
  forge: string,
  repoUrl: string | null | undefined,
): ImageSource {
  const home = repoUrl ? parse(repoUrl) : null;
  return (src) => {
    const u = parse(src);
    if (!u) return null;
    if (forge === 'github') {
      return u.protocol === 'https:' && !u.port && GITHUB_HOSTS.has(u.hostname)
        ? proxied(forge, src)
        : null;
    }
    if (forge === 'forgejo' && home && u.origin === home.origin) {
      return proxied(forge, src);
    }
    return null;
  };
}
