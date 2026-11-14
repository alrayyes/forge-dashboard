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
  'gist.githubusercontent.com',
]);

export type ImageSource = (src: string) => string | null;

// The issue, pull request or release the text belongs to. A private GitHub
// repository serves an attachment only at a signed address that the server
// finds in the item's rendered body, so it has to know which item that is
// (#3469).
export type ImageItem = {
  fullName: string;
  number?: number;
  tag?: string;
  // A comment's body is its own object with its own signed addresses, so the
  // server reads that comment, not the item (#3676).
  comment?: string;
};

function parse(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.username || u.password ? null : u;
  } catch {
    return null;
  }
}

function proxied(forge: string, src: string, item?: ImageItem): string {
  const base = `/api/v1/images?forge=${forge}&url=${encodeURIComponent(src)}`;
  if (!item || forge !== 'github' || !isAttachment(src)) return base;
  const which =
    item.comment !== undefined
      ? `comment=${encodeURIComponent(item.comment)}`
      : item.tag !== undefined
        ? `tag=${encodeURIComponent(item.tag)}`
        : `number=${item.number}`;
  return `${base}&fullName=${encodeURIComponent(item.fullName)}&${which}`;
}

function isAttachment(src: string): boolean {
  const u = parse(src);
  return (
    u?.hostname === 'github.com' && u.pathname.startsWith('/user-attachments/')
  );
}

// `repoUrl` is the repository the text belongs to. A Forgejo item may embed
// images from its own instance only; a GitHub item from GitHub's own hosts.
export function imageSourceFor(
  forge: string,
  repoUrl: string | null | undefined,
  item?: ImageItem,
): ImageSource {
  const home = repoUrl ? parse(repoUrl) : null;
  return (src) => {
    const u = parse(src);
    if (!u) return null;
    if (forge === 'github') {
      return u.protocol === 'https:' && !u.port && GITHUB_HOSTS.has(u.hostname)
        ? proxied(forge, src, item)
        : null;
    }
    if (forge === 'forgejo' && home && u.origin === home.origin) {
      return proxied(forge, src);
    }
    return null;
  };
}
