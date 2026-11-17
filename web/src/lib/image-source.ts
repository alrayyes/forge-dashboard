// Where an image embedded in a pull request, issue or release is loaded from
// (#3405). The page never asks a forge or a third party for it: it asks this
// server, which fetches it with the saved token and passes the bytes on. This
// decides which addresses are worth asking for; the server holds the same
// rules and is the one that enforces it, so a refusal here is only a saved
// round trip and a link instead of a broken picture.
import { type ImagePolicy, imagePolicyOf } from './forges';

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

function proxied(
  forge: string,
  policy: ImagePolicy,
  src: string,
  item?: ImageItem,
): string {
  const base = `/api/v1/images?forge=${forge}&url=${encodeURIComponent(src)}`;
  if (!item || !isSignedAttachment(policy, src)) return base;
  const which =
    item.comment !== undefined
      ? `comment=${encodeURIComponent(item.comment)}`
      : item.tag !== undefined
        ? `tag=${encodeURIComponent(item.tag)}`
        : `number=${item.number}`;
  return `${base}&fullName=${encodeURIComponent(item.fullName)}&${which}`;
}

function isSignedAttachment(policy: ImagePolicy, src: string): boolean {
  return (
    policy.signedAttachmentPrefix !== undefined &&
    (parse(src)?.href.startsWith(policy.signedAttachmentPrefix) ?? false)
  );
}

// `repoUrl` is the repository the text belongs to. What a forge's item may
// embed is the forge's image policy: its fixed hosts, or, with none named, its
// own instance.
export function imageSourceFor(
  forge: string,
  repoUrl: string | null | undefined,
  item?: ImageItem,
): ImageSource {
  const home = repoUrl ? parse(repoUrl) : null;
  const policy = imagePolicyOf(forge);
  return (src) => {
    const u = parse(src);
    if (!u || !policy) return null;
    const allowed = policy.hosts.length
      ? u.protocol === 'https:' && !u.port && policy.hosts.includes(u.hostname)
      : !!home && u.origin === home.origin;
    return allowed ? proxied(forge, policy, src, item) : null;
  };
}
