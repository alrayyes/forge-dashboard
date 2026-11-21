// What the changelog page tells the Markdown renderer so an issue or pull
// request number in a release note is a reference the page can open in a
// dialog (#3764). The page has no snapshot of tracked repositories, so every
// reference is treated as one the dashboard does not track: it is asked of
// the forge, and a click opens the read-only dialog once that answer is in, or
// follows the forge link (see reference-prefetch.ts).

export type ProjectReferences = {
  repoUrl: string;
  forge: string;
  tracked: (repo: string) => boolean;
};

// "https://github.com/o/r/releases/tag/v1.2.3", as scripts/changelog-json.ts
// writes it. Only GitHub is read: it is where this project's releases live,
// and the forge id the dashboard uses for it is `github`.
const RELEASE = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\/tag\/[^/]+$/;

export function projectReferences(
  releaseUrl: string,
): ProjectReferences | null {
  const m = RELEASE.exec(releaseUrl);
  if (!m) return null;
  return { repoUrl: m[1], forge: 'github', tracked: () => false };
}
